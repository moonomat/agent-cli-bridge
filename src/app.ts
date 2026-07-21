/**
 * agent-cli-bridge HTTP/SSE app (MCP-execution-proxy shape).
 *
 *   GET  /health    → { ok, service, version } — connection/version probe.
 *   POST /stream    body: { conversationId, model, systemPrompt?, tools?, reasoning?, resume?, input }
 *                   input = { kind:"user", content } | { kind:"tool_result", toolUseId, content }
 *                   → SSE of assistant-message event frames for ONE turn, then [DONE].
 *   POST /reattach  body: { conversationId, cursor } → replay/continue the current turn's SSE.
 *   POST /close     body: { conversationId } → tear down the conversation's CLI.
 *   POST /mcp-exec  (internal, from the MCP proxy) body: { conversationId, toolUseId, name, args }
 *                   → blocks until the client delivers the tool result, then { content }.
 *
 * EVERY endpoint (including /health — no public requests) requires
 * `Authorization: Bearer <pairing token>`, checked BEFORE the request body is
 * read. See README.md for the full wire spec.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeOrigin } from "./config.js";
import {
  handleStream, handleMcpExec, closeConversation, handleReattach,
  type CreateOpts, type SseSink, type McpToolDef,
} from "./conversation.js";
import { normalizeModel, type AssistantMessage, type ThinkingLevel } from "./api-types.js";
import type { EngineStatuses } from "./bridge/process-manager.js";

export interface AppOptions {
  /** Required Bearer token; null disables auth (--no-token). */
  token: string | null;
  /** CORS origin allowlist; empty = reflect any Origin. */
  origins: string[];
  heartbeatMs: number;
  maxBodyBytes: number;
  scratchDir: string;
  /** Per-engine CLI availability supplier, reported in /health. A supplier
   *  (not a snapshot) so a CLI signed in after startup is picked up. */
  engines?: () => EngineStatuses;
}

/** Injected by the bundle build (build.mjs `define`); absent when running from source. */
declare const __BRIDGE_VERSION__: string | undefined;

const VERSION: string = (() => {
  if (typeof __BRIDGE_VERSION__ === "string") return __BRIDGE_VERSION__;
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf-8").digest();

/** A parsed JSON request body: always a plain object (null/arrays/primitives
 *  normalize to {}), so field access is safe and fields are `unknown`. */
type JsonBody = Record<string, unknown>;

/** A spec-complete assistant message carrying a bridge-level error as text —
 *  every field the wire format declares mandatory is present, so clients typed
 *  strictly against the README spec don't crash on an error turn. */
function bridgeErrorMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "agent-cli-bridge",
    provider: "anthropic",
    model: "unknown",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Create the bridge's HTTP server (not yet listening). Exported so tests can
 *  run the full request pipeline (auth, CORS, body cap) without a real CLI. */
export function createBridgeApp(opts: AppOptions): Server {
  const tokenHash = opts.token === null ? null : sha256(opts.token);
  const allowedOrigins = opts.origins.map(normalizeOrigin);

  /** Whether the request's Origin passes the allowlist (no allowlist, or no
   *  Origin at all — curl, the MCP proxy — always passes). Sets the CORS
   *  headers only for a passing browser origin. */
  function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(normalizeOrigin(origin))) {
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    // Reflect whatever headers the preflight asks for (the client's extra-headers
    // map is free-form, e.g. proxy auth headers), with a static fallback for
    // non-preflight requests. The token — not header names — is the boundary.
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ??
        "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret",
    );
    // Private Network Access: lets a page on a public (HTTPS) origin reach this
    // loopback server — Chrome's PNA preflight requires this on the OPTIONS reply.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    return true;
  }

  /** Constant-time Bearer-token check (hash both sides so lengths match). */
  function authorized(req: IncomingMessage): boolean {
    if (tokenHash === null) return true;
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return false;
    return timingSafeEqual(sha256(header.slice("Bearer ".length).trim()), tokenHash);
  }

  /** Buffer and parse a JSON body, bounded by maxBodyBytes (413 beyond it). */
  async function readJson(req: IncomingMessage): Promise<JsonBody> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > opts.maxBodyBytes) {
        req.destroy();
        throw Object.assign(new Error("payload too large"), { status: 413 });
      }
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonBody) : {};
  }

  /** Open an SSE response with the standard headers and a keepalive heartbeat.
   *  Heartbeat comment frames carry no `data:` line, so the client's SSE parser
   *  skips them; they keep the connection from going idle long enough for a
   *  fronting proxy (e.g. a tunnel) to reap it mid-turn — and they make a dead
   *  client surface promptly (the write fails -> "close"). */
  function openSse(res: ServerResponse): { sink: SseSink; dispose: () => void } {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      res.write(": ping\n\n");
    }, opts.heartbeatMs);
    const sink: SseSink = {
      write: (s) => { if (!res.writableEnded) res.write(s); },
      end: () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); },
    };
    return { sink, dispose: () => clearInterval(heartbeat) };
  }

  /** Emit a terminal error turn on the sink (used when a handler throws). */
  function sinkError(sink: SseSink, message: string): void {
    sink.write(`data: ${JSON.stringify({ type: "done", reason: "stop", message: bridgeErrorMessage(message) })}\n\n`);
    sink.write("data: [DONE]\n\n");
    sink.end();
  }

  /** 4xx a body-read failure (bad JSON, oversize) uniformly. */
  function badBody(res: ServerResponse, err: unknown): void {
    const status = (err as { status?: number })?.status === 413 ? 413 : 400;
    res.writeHead(status);
    res.end(status === 413 ? "payload too large" : "bad json");
  }

  /**
   * Run an SSE handler with the shared attach/detach bookkeeping. On socket
   * close mid-turn we DETACH (not tear down): the CLI keeps running and a
   * returning client can reattach via /reattach (mobile background, network
   * blip). Deliberate teardown comes through /close instead, and abandoned
   * conversations are reaped by the idle sweeper. `detach` is bound to THIS
   * response's turn so a stale close can't detach a later turn; if the socket
   * already closed before the turn attached, detach immediately.
   */
  async function runSse(
    res: ServerResponse,
    fn: (sink: SseSink, onAttached: (detach: () => void) => void) => Promise<void>,
  ): Promise<void> {
    const { sink, dispose } = openSse(res);
    let detach: (() => void) | undefined;
    let closed = false;
    res.on("close", () => { dispose(); closed = true; detach?.(); });
    try {
      await fn(sink, (d) => { detach = d; if (closed) d(); });
    } catch (err) {
      sinkError(sink, "bridge error: " + (err as Error)?.message);
    }
  }

  async function onStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: JsonBody;
    try { body = await readJson(req); } catch (err) { badBody(res, err); return; }
    if (!body.conversationId || !body.model || !body.input) {
      res.writeHead(400); res.end("missing conversationId/model/input"); return;
    }
    let model;
    try { model = normalizeModel(body.model); } catch (err) {
      res.writeHead(400); res.end((err as Error).message); return;
    }

    const addr = server.address();
    const createOpts: CreateOpts = {
      conversationId: String(body.conversationId),
      model,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      tools: Array.isArray(body.tools) ? (body.tools as McpToolDef[]) : undefined,
      reasoning: body.reasoning as ThinkingLevel | undefined,
      // Restore of a persisted session -> resume the CLI's on-disk conversation
      // instead of creating a new one (see spawnConversation).
      resume: body.resume === true,
      sidecarPort: typeof addr === "object" && addr ? addr.port : 8787,
      sidecarToken: opts.token,
      scratchDir: opts.scratchDir,
    };
    const input = body.input as Parameters<typeof handleStream>[1];
    await runSse(res, (sink, onAttached) => handleStream(createOpts, input, sink, onAttached));
  }

  async function onReattach(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: JsonBody;
    try { body = await readJson(req); } catch (err) { badBody(res, err); return; }
    if (!body.conversationId) { res.writeHead(400); res.end("missing conversationId"); return; }

    const cursor = typeof body.cursor === "number" && Number.isFinite(body.cursor)
      ? Math.max(0, Math.floor(body.cursor))
      : 0;
    await runSse(res, (sink, onAttached) =>
      handleReattach(String(body.conversationId), cursor, sink, onAttached));
  }

  async function onClose(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req).catch((): JsonBody => ({}));
    if (body.conversationId) closeConversation(String(body.conversationId));
    res.writeHead(204); res.end();
  }

  async function onMcpExec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: JsonBody;
    try { body = await readJson(req); } catch (err) { badBody(res, err); return; }
    if (!body.conversationId || typeof body.name !== "string") {
      res.writeHead(400); res.end("missing conversationId/name"); return;
    }
    try {
      const out = await handleMcpExec(
        String(body.conversationId),
        String(body.toolUseId ?? ""),
        body.name,
        body.args,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (err) {
      // Never let an /mcp-exec failure become an unhandled rejection — that
      // would take down the whole bridge (and every conversation with it).
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: "bridge error: " + (err as Error)?.message, isError: true }));
    }
  }

  const server: Server = createServer((req, res) => {
    if (!applyCors(req, res)) { res.writeHead(403); res.end("origin not allowed"); return; }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    // Auth gate for EVERYTHING (incl. /health) — BEFORE any body is read. No
    // public requests: an unpaired caller learns nothing about this server.
    if (!authorized(req)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("missing or invalid bearer token — pair with the token the bridge printed at startup");
      return;
    }
    const url = new URL(req.url ?? "/", "http://bridge.invalid");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // `engines` tells the client which model families are usable.
      res.end(JSON.stringify({
        ok: true, service: "agent-cli-bridge", version: VERSION,
        ...(opts.engines ? { engines: opts.engines() } : {}),
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/stream") { void onStream(req, res); return; }
    if (req.method === "POST" && url.pathname === "/reattach") { void onReattach(req, res); return; }
    if (req.method === "POST" && url.pathname === "/mcp-exec") { void onMcpExec(req, res); return; }
    if (req.method === "POST" && url.pathname === "/close") { void onClose(req, res); return; }
    res.writeHead(404); res.end("not found");
  });

  return server;
}
