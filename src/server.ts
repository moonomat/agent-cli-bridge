/**
 * agent-cli-bridge entry point: resolve options, probe the agent CLIs (claude,
 * codex), start the loopback HTTP/SSE server and print the pairing token.
 *
 * The bridge deliberately binds 127.0.0.1 only — there is no flag to bind a
 * non-loopback interface. Remote access goes through a tunnel (see README.md).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOptions } from "./config.js";
import { createBridgeApp } from "./app.js";
import { probeEngines, probeEnginesCached, killAllProcesses } from "./bridge/process-manager.js";

const HOST = "127.0.0.1";
const opts = resolveOptions();
const SCRATCH_DIR = join(tmpdir(), "agent-cli-bridge-scratch");
mkdirSync(SCRATCH_DIR, { recursive: true });

// Which agent CLIs can this bridge drive? One is enough to run; each engine's
// status is reported in /health so clients enable only the usable model
// families. Auth warnings are best-effort — the definitive error surfaces (as
// a readable chat turn) on first use.
const engines = probeEngines();
if (engines.claude === "missing" && engines.codex === "missing") {
  throw new Error(
    "No agent CLI found. Install at least one:\n" +
      "  Claude Code: npm install -g @anthropic-ai/claude-code  (then run `claude` once to sign in)\n" +
      "  Codex:       npm install -g @openai/codex               (then run `codex login`)",
  );
}
if (engines.claude === "unauthenticated") console.warn("[agent-cli-bridge] Claude CLI found but not authenticated — run `claude` once in a terminal.");
if (engines.codex === "unauthenticated") console.warn("[agent-cli-bridge] codex CLI found but not authenticated — run `codex login` in a terminal.");
if (engines.claude === "missing") console.warn("[agent-cli-bridge] Claude CLI not found — Claude models disabled.");
if (engines.codex === "missing") console.warn("[agent-cli-bridge] codex CLI not found — Codex models disabled.");

const server = createBridgeApp({
  token: opts.token,
  origins: opts.origins,
  heartbeatMs: opts.heartbeatMs,
  maxBodyBytes: opts.maxBodyBytes,
  scratchDir: SCRATCH_DIR,
  // Live (cached) probe: a CLI signed in after startup shows up in /health
  // on the client's next connection check, without a bridge restart.
  engines: () => probeEnginesCached(),
});

process.on("exit", killAllProcesses);
process.on("SIGINT", () => { killAllProcesses(); process.exit(0); });
process.on("SIGTERM", () => { killAllProcesses(); process.exit(0); });

server.listen(opts.port, HOST, () => {
  console.log(`[agent-cli-bridge] listening on http://${HOST}:${opts.port}`);
  console.log(`[agent-cli-bridge] engines: claude=${engines.claude} codex=${engines.codex}`);
  if (opts.token === null) {
    console.warn("[agent-cli-bridge] WARNING: --no-token — no auth; ANY web page you visit can drive your subscriptions while this runs.");
  } else if (opts.tokenGenerated) {
    console.log(`[agent-cli-bridge] Pairing token: ${opts.token}`);
    console.log("[agent-cli-bridge] Paste it into your app's bridge settings. (Set AGENT_CLI_BRIDGE_TOKEN or --token for a fixed one.)");
  } else {
    console.log("[agent-cli-bridge] Using the configured pairing token.");
  }
  if (opts.origins.length > 0) console.log(`[agent-cli-bridge] Allowed origins: ${opts.origins.join(", ")}`);
});
