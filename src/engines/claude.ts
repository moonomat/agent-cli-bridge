/**
 * Claude engine: one persistent `claude` CLI process per conversation, driven
 * over stream-json stdin/stdout. The CLI natively emits Claude-API stream
 * events, so translation to EngineIO.event is a pass-through.
 */
import spawn from "cross-spawn";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { parseLine } from "../bridge/stream-parser.js";
import { mapThinkingEffort } from "../bridge/thinking-config.js";
import { registerProcess, forceKillProcess } from "../bridge/process-manager.js";
import { ONE_TOOL_PER_TURN_RULE, type CreateOpts, type Engine, type EngineIO, type EngineSession } from "./engine.js";

// The proxy is a separate .cjs file (spawned, never imported, so it survives
// bundling as-is). Bundled layout (dist/, install dir): it sits beside the
// entry file; source layout: it lives in src/bridge/.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_SERVER =
  [join(HERE, "mcp-proxy-server.cjs"), join(HERE, "..", "bridge", "mcp-proxy-server.cjs")].find((p) => existsSync(p)) ??
  join(HERE, "mcp-proxy-server.cjs");

/** conversationId is client-supplied; sanitize it before using it in ANY file
 *  path so a hostile or odd id ('../x', 'a/b') can't escape the directory or
 *  ENOENT the write. Used for the session markers and all per-conversation
 *  temp files. (The raw id still goes to `claude --session-id`, which does its
 *  own validation.) */
export const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

// Marker files recording which conversation ids already have an on-disk CLI
// session, so a respawn after the process was reaped or the sidecar restarted
// resumes (--resume) instead of re-creating the id (--session-id errors on an id
// that already exists). The client's `resume` flag covers the complementary case
// where these markers are wiped (e.g. /tmp cleared on reboot) but the CLI's own
// ~/.claude session survives.
const SESSIONS_DIR = join(tmpdir(), "agent-cli-bridge-sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const sessionMarker = (id: string): string => join(SESSIONS_DIR, safeId(id));

// With bypassPermissions the CLI would otherwise use its own built-in
// Read/Write/Edit/etc. against the scratch dir. Disable them so Claude uses ONLY
// our MCP custom tools (which proxy to the client). ToolSearch stays enabled —
// Claude uses it to discover MCP tools.
const DISABLED_BUILTINS = [
  "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob",
  "Bash", "BashOutput", "KillShell", "KillBash",
  "Task", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite",
];

/** The proxying MCP server's launch spec (shared by both engines' MCP configs):
 *  writes the tool schemas + pairing token to an owner-only (0600) file and
 *  points the proxy at this bridge's /mcp-exec. The token travels in that file,
 *  never argv (visible in ps) and never env (codex does not pass its env on to
 *  the MCP servers it spawns). */
export function mcpProxyServerConfig(opts: CreateOpts): {
  command: string;
  args: string[];
} {
  const fileId = safeId(opts.conversationId);
  const schemaFile = join(tmpdir(), `agent-cli-bridge-schemas-${fileId}.json`);
  writeFileSync(schemaFile, JSON.stringify({ tools: opts.tools ?? [], token: opts.sidecarToken ?? null }), { mode: 0o600 });
  chmodSync(schemaFile, 0o600); // writeFileSync's mode is ignored for pre-existing files
  return {
    command: process.execPath,
    args: [PROXY_SERVER, schemaFile, `http://127.0.0.1:${opts.sidecarPort}/mcp-exec`, opts.conversationId],
  };
}

/** Write the per-conversation MCP config file for `claude --mcp-config`.
 *  `alwaysLoad` exempts the server from Claude Code's deferred tool loading, so
 *  the tool schemas are in context from the start — otherwise the model burns a
 *  ToolSearch round-trip on first use and narrates the discovery to the user. */
function writeMcpProxyConfig(opts: CreateOpts): string {
  const mcpConfigFile = join(tmpdir(), `agent-cli-bridge-mcp-${safeId(opts.conversationId)}.json`);
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { "custom-tools": { ...mcpProxyServerConfig(opts), alwaysLoad: true } } }));
  return mcpConfigFile;
}

export const claudeEngine: Engine = {
  id: "claude",

  spawn(opts: CreateOpts, io: EngineIO): EngineSession {
    const { conversationId, model, systemPrompt, reasoning, scratchDir, resume } = opts;
    mkdirSync(scratchDir, { recursive: true });
    const fileId = safeId(conversationId);
    const mcpConfigFile = writeMcpProxyConfig(opts);

    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages", "--model", model.id,
      "--permission-mode", "bypassPermissions", "--mcp-config", mcpConfigFile,
    ];
    // Durable sessions: the CLI persists every conversation to disk keyed by its
    // session id. A brand-new conversation claims the id with --session-id; any
    // respawn (client restoring a saved session, or a convs-miss after the process
    // was reaped / the sidecar restarted) re-loads it with --resume — --session-id
    // errors on an id that already exists. Resume when the client asks OR when a
    // marker shows we already created this id. Both flags require --print (always
    // -p) and are mutually exclusive. cwd is a single shared scratch dir, so the
    // CLI's project-scoped session store is stable and --resume finds the session.
    const marker = sessionMarker(conversationId);
    const useResume = resume || existsSync(marker);
    args.push(useResume ? "--resume" : "--session-id", conversationId);
    // The marker is written on the FIRST output line (proof the CLI persisted the
    // session), not here — see the rl "line" handler. Writing it optimistically would
    // strand a create-spawn that dies before persisting (unauthenticated CLI, bad
    // model, crash): the marker would force every later respawn onto --resume, which
    // fails forever and misreads a startup failure as "session expired". With no
    // marker, a failed create simply retries as a create and self-heals.
    if (systemPrompt) {
      const spFile = join(tmpdir(), `agent-cli-bridge-sysprompt-${fileId}.txt`);
      writeFileSync(spFile, systemPrompt + ONE_TOOL_PER_TURN_RULE, "utf-8");
      args.push("--system-prompt-file", spFile);
    }
    const effort = mapThinkingEffort(reasoning, model.id);
    if (effort) args.push("--effort", effort);
    args.push("--disallowedTools", DISABLED_BUILTINS.join(","));

    console.error(`[agent-cli-bridge] spawn claude conversation ${conversationId} model=${model.id} effort=${effort ?? "default"} reasoning=${reasoning ?? "off"} tools=[${(opts.tools ?? []).map((t) => t.name).join(",")}]`);
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], cwd: scratchDir }) as ChildProcess;
    registerProcess(proc); // killed on server exit

    /** True once the CLI produced parseable output — proof the process loaded
     *  (resume) or created (--session-id) its on-disk session. */
    let producedOutput = false;

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
    rl.on("line", (line: string) => {
      const msg = parseLine(line);
      if (!msg) return;
      io.activity();
      // First parseable output proves the CLI loaded (resume) or created
      // (--session-id) its on-disk session: record it, and write the marker
      // (idempotently) so a later reap/respawn resumes this id rather than
      // re-creating it. Marking only after proof-of-persistence is what lets a
      // failed create-spawn self-heal — it leaves no marker, so the next attempt
      // retries create.
      if (!producedOutput) {
        producedOutput = true;
        try { writeFileSync(marker, ""); } catch { /* best-effort marker */ }
      }
      if (msg.type === "stream_event") {
        // Only top-level events (sub-agent events have parent_tool_use_id).
        if ((msg as { parent_tool_use_id?: unknown }).parent_tool_use_id) return;
        io.event(msg.event);
      } else if (msg.type === "result") {
        // The CLI finished processing the current input (no more tools) -> turn done.
        // A non-success subtype (error_max_turns / error_during_execution) would
        // otherwise present as a silent empty stop — log it and pass a fallback note.
        const subtype = msg.subtype as string | undefined;
        let note: string | undefined;
        if (subtype && subtype !== "success") {
          console.error(`[agent-cli-bridge] ${conversationId} result subtype=${subtype}`);
          note = `The local Claude CLI ended the turn early (${subtype}).`;
        }
        io.turnEnded(note);
      }
      // control_request shouldn't occur under bypassPermissions; ignore if it does.
    });

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
      console.error(`[agent-cli-bridge] ${conversationId} claude spawn error: ${err.message}`);
      notifyClosed(`The claude CLI could not be started (${err.message}). Is it installed and on PATH on the bridge machine?`);
    });
    proc.on("close", () => {
      // If the process never produced ANY output this spawn, it failed to START —
      // surface why (stderr is swallowed), distinguishing a dead --resume from a
      // dead --session-id. A close AFTER output flowed is a mid-conversation
      // drop, not a startup failure, so end quietly.
      const note = producedOutput
        ? undefined
        : useResume
          ? "Couldn't resume the previous conversation — it may have expired. Start a new session to continue."
          : "The Claude CLI exited without output. It may not be signed in (run `claude` once in a terminal to authenticate), or the request was rejected — check the agent-cli-bridge console.";
      notifyClosed(note);
    });
    proc.stderr?.on("data", () => {/* swallow; CLI is chatty on stderr */});

    return {
      send(content) {
        proc.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      },
      kill() {
        forceKillProcess(proc);
      },
    };
  },
};
