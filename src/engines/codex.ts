/**
 * Codex engine: one persistent `codex app-server` process per conversation,
 * driven over its JSONL JSON-RPC stdio protocol.
 *
 * Shape of the integration (validated against codex-cli 0.144):
 *  - initialize/initialized handshake, then thread/start (new) or thread/resume
 *    (the codex-generated thread id is remembered in a marker file, keyed by our
 *    conversationId).
 *  - The client's tools are registered through the SAME blocking MCP proxy as
 *    the claude engine, via process-level `-c mcp_servers.*` overrides on the
 *    app-server spawn (per-thread thread/start config stopped binding MCP
 *    tools ~2026-07-17; see the spawn comment). The pairing token rides in
 *    the proxy's owner-only schema file, never argv, so it stays out of `ps`.
 *  - Codex's own tools are disabled: read-only sandbox, shell/view-image
 *    feature flags off, web search off. approvalPolicy "never" covers the rest.
 *  - MCP tool-call approval prompts (server->client requests) are auto-allowed:
 *    the only reachable tools are the client's own, which it executes itself.
 *  - Output notifications are translated into Claude-API-style stream events so
 *    the existing event bridge does all accumulation/SSE work: agentMessage ->
 *    text block, reasoning summaries -> thinking block (codex exposes real
 *    summary text), thread/tokenUsage -> usage, turn/completed -> turn end.
 */
import spawn from "cross-spawn";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { ClaudeApiEvent } from "../bridge/types.js";
import type { ThinkingLevel } from "../api-types.js";
import { registerProcess, forceKillProcess } from "../bridge/process-manager.js";
import { safeId, mcpProxyServerConfig } from "./claude.js";
import { ONE_TOOL_PER_TURN_RULE, type CreateOpts, type Engine, type EngineIO, type EngineSession } from "./engine.js";

// conversationId -> codex thread id. Codex generates its own thread ids
// (UUIDv7), so resuming a conversation needs this mapping to survive process
// reaps and bridge restarts. Best-effort like the claude session markers: if
// the marker is gone (tmp cleared), the conversation starts fresh.
const THREADS_DIR = join(tmpdir(), "agent-cli-bridge-codex-threads");
mkdirSync(THREADS_DIR, { recursive: true });
const threadMarker = (id: string): string => join(THREADS_DIR, safeId(id));

/** Client reasoning level -> codex reasoning effort (same vocabulary, minus
 *  "minimal"; codex's max/ultra tiers are deliberately not mapped — xhigh is
 *  the highest a client can request). */
function mapCodexEffort(reasoning?: ThinkingLevel): string | undefined {
  if (reasoning === undefined) return undefined;
  return reasoning === "minimal" ? "low" : reasoning;
}

/** Anthropic-style user content blocks (the /stream wire format) -> codex
 *  UserInput items. Images arrive base64 and are passed as data URLs. */
function toUserInput(content: string | unknown[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content, text_elements: [] }];
  }
  const items: unknown[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === "text" && typeof b.text === "string") {
      items.push({ type: "text", text: b.text, text_elements: [] });
    } else if (b?.type === "image") {
      const src = b.source as { media_type?: string; data?: string } | undefined;
      if (src?.data) items.push({ type: "image", url: `data:${src.media_type ?? "image/png"};base64,${src.data}` });
    }
  }
  return items.length ? items : [{ type: "text", text: "", text_elements: [] }];
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export const codexEngine: Engine = {
  id: "codex",

  spawn(opts: CreateOpts, io: EngineIO): EngineSession {
    const { conversationId, model, systemPrompt, reasoning, scratchDir, resume } = opts;
    mkdirSync(scratchDir, { recursive: true });
    const marker = threadMarker(conversationId);
    const knownThreadId = ((): string | null => {
      try { return existsSync(marker) ? readFileSync(marker, "utf-8").trim() || null : null; } catch { return null; }
    })();
    // The client asked to resume but the conversationId -> codex-thread-id
    // marker is gone (tmp cleared on reboot): we cannot find the thread, and
    // silently starting a fresh one would show the old transcript to a model
    // with no memory of it. Surface it like the claude engine's dead --resume.
    const resumeLost = !!resume && !knownThreadId;

    console.error(`[agent-cli-bridge] spawn codex conversation ${conversationId} model=${model.id} reasoning=${reasoning ?? "off"} resume=${knownThreadId ? "thread" : "new"} tools=[${(opts.tools ?? []).map((t) => t.name).join(",")}]`);
    // MCP + feature config goes on the app-server process as -c overrides, NOT
    // in thread/start's per-thread `config`: since ~2026-07-17 (codex 0.144.5,
    // server-side change) per-thread mcp_servers still SPAWN the proxy — ready
    // status and all — but its tools never get bound into a fresh thread's tool
    // surface, so the model reports them unavailable. Process-level config
    // binds reliably; one app-server per conversation makes it equivalent.
    // The pairing token travels in the proxy's 0600 schema file (codex strips
    // its env when spawning MCP servers, and argv would show in `ps`).
    const proxy = mcpProxyServerConfig(opts);
    const configOverrides = [
      "-c", `mcp_servers.custom-tools.command=${JSON.stringify(proxy.command)}`,
      "-c", `mcp_servers.custom-tools.args=${JSON.stringify(proxy.args)}`,
      "-c", "features.shell_tool=false",
      "-c", "features.view_image_tool=false",
      "-c", "tools.web_search=false",
    ];
    const proc = spawn("codex", ["app-server", ...configOverrides], { stdio: ["pipe", "pipe", "pipe"], cwd: scratchDir }) as ChildProcess;
    registerProcess(proc);
    proc.stderr?.on("data", () => {/* swallow; codex logs INFO lines on stderr */});

    // io.closed exactly once, whichever of 'error'/'close' fires (a failed
    // spawn emits 'error' and may never emit 'close'; without a listener the
    // ChildProcess 'error' event would crash the whole bridge process).
    let closedNotified = false;
    const notifyClosed = (note?: string): void => {
      if (closedNotified) return;
      closedNotified = true;
      io.closed(note);
    };
    proc.on("error", (err: Error) => {
      console.error(`[agent-cli-bridge] ${conversationId} codex spawn error: ${err.message}`);
      notifyClosed(`The codex CLI could not be started (${err.message}). Is it installed and on PATH on the bridge machine?`);
    });

    // ── Tiny JSONL JSON-RPC client ────────────────────────────────────────────
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const DEBUG = !!process.env.AGENT_CLI_BRIDGE_DEBUG;
    function write(obj: unknown): void {
      if (DEBUG) console.error(`[agent-cli-bridge] ${conversationId} codex >>> ${JSON.stringify(obj).slice(0, 500)}`);
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
    }
    function request(method: string, params: Record<string, unknown>): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      });
    }

    // ── Turn/translation state ────────────────────────────────────────────────
    // The event bridge keys blocks by a numeric per-turn index; codex keys items
    // by string ids. Track the mapping plus the currently-open block so items
    // close cleanly even when notifications interleave.
    //
    // Known race (accepted): a tool pause ends the client step via the MCP
    // proxy's HTTP call, which can overtake still-buffered stdout notifications.
    // Deltas landing after the step ended go to an ended (emit-gated) or fresh
    // bridge that never saw the block's start and are dropped — the block's text
    // up to the pause was already streamed live, so at most a trailing fragment
    // of a reasoning/preamble block is lost from the transcript.
    let producedOutput = false;
    let startupFailure: string | undefined;
    // The custom-tools MCP server starts asynchronously after thread/start; a
    // turn/start issued before it is READY makes the model's first request see
    // an empty tool list (it then tells the user the tools don't exist). Gate
    // the first turn on the ready notification — with a timeout backstop so a
    // rejected config degrades to a tool-less turn instead of a hang.
    let mcpReadyResolve: (() => void) | null = null;
    const mcpReady: Promise<void> = (opts.tools?.length ?? 0) > 0
      ? new Promise((r) => { mcpReadyResolve = r; })
      : Promise.resolve();
    // Latched after the first send's gate, so a codex build that never emits the
    // ready notification costs ONE 15s wait, not 15s on every message.
    let mcpGatePassed = false;
    let blockIndex = 0;
    const openBlocks = new Map<string, { index: number; kind: "text" | "thinking"; hasContent: boolean }>();
    let lastErrorNote: string | undefined;
    // codex reports THREAD-cumulative token usage; the wire format wants each
    // CLIENT STEP's own usage (one /stream call — a codex turn spans the whole
    // agentic run across many steps). Baseline at every step boundary (tool
    // pause via clientTurnEnded, and turn/completed), report (total - baseline).
    // On a RESUMED thread the totals include all history, so the baseline is
    // seeded from the first notification (total minus its own request's `last`)
    // rather than zero — otherwise the first step reports the whole thread.
    let usageBaselineSeeded = false;
    const usageBaseline = { input: 0, cached: 0, output: 0 };
    const usageLatest = { input: 0, cached: 0, output: 0 };

    function openBlock(itemId: string, kind: "text" | "thinking"): void {
      if (openBlocks.has(itemId)) return;
      const index = blockIndex++;
      openBlocks.set(itemId, { index, kind, hasContent: false });
      io.event({
        type: "content_block_start",
        index,
        content_block: { type: kind === "text" ? "text" : "thinking" },
      } as ClaudeApiEvent);
    }
    function deltaBlock(itemId: string, kind: "text" | "thinking", text: string): void {
      if (!openBlocks.has(itemId)) openBlock(itemId, kind);
      const block = openBlocks.get(itemId)!;
      block.hasContent = true;
      io.event({
        type: "content_block_delta",
        index: block.index,
        delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
      } as ClaudeApiEvent);
    }
    function closeBlock(itemId: string, finalText?: string): void {
      const block = openBlocks.get(itemId);
      if (!block) return;
      openBlocks.delete(itemId);
      // A completed item whose deltas never arrived (short message, race) still
      // must carry its text — emit it as one delta before closing.
      if (!block.hasContent && finalText) {
        io.event({
          type: "content_block_delta",
          index: block.index,
          delta: block.kind === "text" ? { type: "text_delta", text: finalText } : { type: "thinking_delta", thinking: finalText },
        } as ClaudeApiEvent);
      }
      io.event({ type: "content_block_stop", index: block.index } as ClaudeApiEvent);
    }
    function closeAllBlocks(): void {
      for (const itemId of [...openBlocks.keys()]) closeBlock(itemId);
    }

    // ── Server->client requests (approvals) ──────────────────────────────────
    // The only tools codex can reach are the client's own MCP tools, which the
    // client executes itself — so approval prompts are auto-allowed. Anything
    // else (shell/patch approval; disabled, but be safe) is declined.
    function answerServerRequest(msg: JsonRpcMessage): void {
      const method = msg.method!;
      if (method === "mcpServer/elicitation/request") {
        write({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: {}, _meta: null } });
      } else if (method === "item/tool/requestUserInput") {
        const answers: Record<string, { answers: string[] }> = {};
        const questions = (msg.params?.questions ?? []) as Array<{
          id: string;
          options?: Array<{ label: string }> | null;
        }>;
        for (const q of questions) {
          const opts_ = q.options ?? [];
          const pick =
            opts_.find((o) => /session|always/i.test(o.label)) ??
            opts_.find((o) => /^(allow|yes|approve)/i.test(o.label)) ??
            opts_[0];
          if (pick) answers[q.id] = { answers: [pick.label] };
        }
        write({ jsonrpc: "2.0", id: msg.id, result: { answers } });
      } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
        write({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } });
      } else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval") {
        write({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } });
      } else {
        // Unknown server request: reply with an error so codex doesn't hang.
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `agent-cli-bridge: unhandled server request ${method}` } });
      }
    }

    // ── Notification translation ──────────────────────────────────────────────
    function handleNotification(msg: JsonRpcMessage): void {
      const p = msg.params ?? {};
      switch (msg.method) {
        case "item/started": {
          const item = p.item as { type?: string; id?: string } | undefined;
          if (item?.type === "agentMessage") openBlock(item.id!, "text");
          else if (item?.type === "reasoning") openBlock(item.id!, "thinking");
          break;
        }
        case "item/agentMessage/delta":
          deltaBlock(String(p.itemId), "text", String(p.delta ?? ""));
          break;
        case "item/reasoning/summaryTextDelta":
          deltaBlock(String(p.itemId), "thinking", String(p.delta ?? ""));
          break;
        case "item/reasoning/summaryPartAdded": {
          // Separator between summary sections within one reasoning block.
          const block = openBlocks.get(String(p.itemId));
          if (block?.hasContent) deltaBlock(String(p.itemId), "thinking", "\n\n");
          break;
        }
        case "item/completed": {
          const item = p.item as { type?: string; id?: string; text?: string; summary?: string[] } | undefined;
          if (item?.type === "agentMessage") closeBlock(item.id!, item.text);
          else if (item?.type === "reasoning") closeBlock(item.id!, (item.summary ?? []).join("\n\n") || undefined);
          break;
        }
        case "thread/tokenUsage/updated": {
          // Map to the Claude-usage shape the event bridge understands. Codex's
          // `total` is thread-cumulative and its inputTokens include cache
          // reads; the wire format wants this turn's usage with input and cache
          // reads separated — hence the baseline subtraction below.
          const tu = p.tokenUsage as { total?: Record<string, number>; last?: Record<string, number> } | undefined;
          const usage = tu?.total;
          if (usage) {
            usageLatest.input = usage.inputTokens ?? 0;
            usageLatest.cached = usage.cachedInputTokens ?? 0;
            usageLatest.output = usage.outputTokens ?? 0;
            if (!usageBaselineSeeded) {
              usageBaselineSeeded = true;
              // Everything before this request (nonzero only on resumed threads).
              usageBaseline.input = Math.max(0, usageLatest.input - (tu?.last?.inputTokens ?? 0));
              usageBaseline.cached = Math.max(0, usageLatest.cached - (tu?.last?.cachedInputTokens ?? 0));
              usageBaseline.output = Math.max(0, usageLatest.output - (tu?.last?.outputTokens ?? 0));
            }
            const cached = Math.max(0, usageLatest.cached - usageBaseline.cached);
            io.event({
              type: "message_start",
              message: {
                usage: {
                  input_tokens: Math.max(0, usageLatest.input - usageBaseline.input - cached),
                  cache_read_input_tokens: cached,
                  output_tokens: Math.max(0, usageLatest.output - usageBaseline.output),
                },
              },
            } as ClaudeApiEvent);
          }
          break;
        }
        case "turn/completed": {
          closeAllBlocks();
          Object.assign(usageBaseline, usageLatest); // next step reports its own delta
          const turn = p.turn as { status?: string; error?: { message?: string } | null } | undefined;
          let note: string | undefined;
          if (turn?.status === "failed") {
            note = `The codex CLI ended the turn with an error${turn.error?.message ? `: ${turn.error.message}` : ""}${lastErrorNote ? ` (${lastErrorNote})` : ""}.`;
            console.error(`[agent-cli-bridge] ${conversationId} codex turn failed: ${turn.error?.message ?? "unknown"}`);
          }
          lastErrorNote = undefined;
          io.turnEnded(note);
          break;
        }
        case "error": {
          // Retryable stream errors (network blips) are transparent to the
          // client; remember the message so a failed turn can explain itself.
          lastErrorNote = String((p.error as { message?: string } | undefined)?.message ?? "");
          if (p.willRetry !== true) console.error(`[agent-cli-bridge] ${conversationId} codex error: ${lastErrorNote}`);
          break;
        }
        case "mcpServer/startupStatus/updated": {
          // Surface MCP proxy startup failures — without the proxy the client's
          // tools silently don't exist and the model just says so.
          if (p.status === "failed" || p.error || p.failureReason) {
            console.error(`[agent-cli-bridge] ${conversationId} codex MCP server ${String(p.name)} ${String(p.status)}: ${String(p.error ?? p.failureReason ?? "")}`);
          }
          // Terminal state for the proxy server unblocks the first turn (see
          // mcpReady) — on "failed" too, degrading to a tool-less turn.
          if (p.name === "custom-tools" && (p.status === "ready" || p.status === "failed")) {
            mcpReadyResolve?.();
            mcpReadyResolve = null;
          }
          break;
        }
        case "warning":
        case "configWarning":
        case "guardianWarning":
          console.error(`[agent-cli-bridge] ${conversationId} codex ${msg.method}: ${String((p as { message?: string }).message ?? JSON.stringify(p))}`);
          break;
        // Everything else (thread/status, rateLimits, …) is noise.
      }
    }

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(trimmed) as JsonRpcMessage; } catch { return; }
      if (DEBUG) console.error(`[agent-cli-bridge] ${conversationId} codex <<< ${trimmed.slice(0, 500)}`);
      io.activity();
      producedOutput = true;
      if (msg.id !== undefined && msg.method === undefined) {
        // Response to one of our requests.
        const entry = pending.get(msg.id as number);
        pending.delete(msg.id as number);
        if (entry) {
          if (msg.error) entry.reject(new Error(msg.error.message ?? "codex app-server error"));
          else entry.resolve(msg.result);
        }
      } else if (msg.method !== undefined && msg.id !== undefined) {
        answerServerRequest(msg);
      } else if (msg.method !== undefined) {
        handleNotification(msg);
      }
    });

    // ── Startup: handshake + thread create/resume, then drain queued sends ───
    let threadId: string | null = null;
    // resumeLost: never initialize a thread — the first send() surfaces the
    // failure and tears down (a never-settling promise keeps sends gated).
    const threadReady: Promise<string> = resumeLost ? new Promise<string>(() => {}) : (async () => {
      await request("initialize", {
        clientInfo: { name: "agent-cli-bridge", title: "agent-cli-bridge", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      write({ jsonrpc: "2.0", method: "initialized" });

      const threadParams: Record<string, unknown> = {
        model: model.id,
        cwd: scratchDir,
        approvalPolicy: "never",
        sandbox: "read-only",
        ...(systemPrompt ? { developerInstructions: systemPrompt + ONE_TOOL_PER_TURN_RULE } : {}),
      };
      const res = (knownThreadId
        ? await request("thread/resume", { threadId: knownThreadId, ...threadParams })
        : await request("thread/start", threadParams)) as { thread?: { id?: string } };
      const id = res?.thread?.id;
      if (!id) throw new Error("codex app-server returned no thread id");
      threadId = id;
      try { writeFileSync(marker, id); } catch { /* best-effort marker */ }
      return id;
    })();
    threadReady.catch((err: Error) => {
      console.error(`[agent-cli-bridge] ${conversationId} codex startup failed: ${err.message}`);
      startupFailure = err.message;
      forceKillProcess(proc);
    });

    proc.on("close", () => {
      const note = producedOutput && !startupFailure
        ? undefined
        : knownThreadId
          ? `Couldn't resume the previous codex conversation${startupFailure ? ` (${startupFailure})` : ""} — start a new session to continue.`
          : `The codex CLI exited${startupFailure ? ` (${startupFailure})` : " without output"}. It may not be signed in (run \`codex login\` in a terminal), or the request was rejected — check the agent-cli-bridge console.`;
      // Reject anything still awaiting a response so no promise hangs forever.
      for (const entry of pending.values()) entry.reject(new Error("codex app-server exited"));
      pending.clear();
      notifyClosed(note);
    });

    return {
      clientTurnEnded() {
        // Same stdout-vs-HTTP race as above: a tokenUsage notification for the
        // request that issued the tool call may arrive after this baseline is
        // taken. Its tokens then count toward the NEXT step — attribution can
        // shift one request across a step boundary, but is never lost or
        // double-counted.
        Object.assign(usageBaseline, usageLatest);
      },
      send(content) {
        if (resumeLost) {
          io.turnEnded("Couldn't resume the previous codex conversation — its session mapping is gone (e.g. after a reboot). Start a new session to continue.");
          forceKillProcess(proc);
          return;
        }
        const effort = mapCodexEffort(reasoning);
        threadReady
          .then(async (id) => {
            // Gate the FIRST turn on the MCP proxy being ready — a turn issued
            // earlier makes the model's request see no tools. Latched so a codex
            // build that never emits the notification waits 15s once, not per send.
            if (!mcpGatePassed) {
              await Promise.race([mcpReady, new Promise<void>((r) => setTimeout(r, 15_000).unref?.())]);
              mcpGatePassed = true;
            }
            return request("turn/start", {
              threadId: id,
              input: toUserInput(content),
              ...(effort ? { effort } : {}),
            });
          })
          .catch((err: Error) => {
            // A rejected turn/start on a HEALTHY process (unavailable model,
            // rejected param) must be surfaced — silently dropping it would
            // render an empty reply. Startup failures also land here; their
            // process was already killed by threadReady's catch and the close
            // handler adds its own note (endTurn is idempotent, first text wins).
            console.error(`[agent-cli-bridge] ${conversationId} codex turn failed to start: ${err.message}`);
            io.turnEnded(`The codex CLI rejected the request (${err.message}).`);
          });
      },
      kill() {
        forceKillProcess(proc);
      },
    };
  },
};
