// Manual end-to-end smoke test for the CODEX engine. Same per-step client loop
// as smoke-claude.mjs, but against a codex model (provider routing picks the codex
// app-server engine). Checks: tool loop, cross-message continuity, /close.
//
//   node scripts/smoke-codex.mjs            # run
//   DUMP=1 node scripts/smoke-codex.mjs     # also print the sidecar log
//
// NOTE: spends ChatGPT/Codex subscription usage (it drives the real CLI). Manual only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791, BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "smoke-test-pairing-token";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const MODEL = { id: "gpt-5.6-terra", provider: "openai" };
const TOOLS = [{ name: "write_file", description: "Write a text file. Args: path, content.",
  inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }];
const SYS = "You create text files using ONLY the write_file tool. Confirm briefly when done.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("node", ["--import", "tsx", "src/server.ts"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_CLI_BRIDGE_PORT: String(PORT), AGENT_CLI_BRIDGE_TOKEN: TOKEN } });
let srvlog = "";
srv.stdout.on("data", (d) => (srvlog += d)); srv.stderr.on("data", (d) => (srvlog += d));

async function stream(conv, input, signal) {
  const res = await fetch(`${BASE}/stream`, { method: "POST", headers: H, signal,
    body: JSON.stringify({ conversationId: conv, model: MODEL, systemPrompt: SYS, tools: TOOLS, reasoning: "low", input }) });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", thinking = "", toolCall = null, reason = null, usage = null;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const f = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = f.split("\n").find((l) => l.startsWith("data:")); if (!dl) continue;
      const d = dl.slice(5).trim(); if (d === "[DONE]") return { reason, text, thinking, toolCall, usage };
      let ev; try { ev = JSON.parse(d); } catch { continue; }
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "thinking_delta") thinking += ev.delta;
      if (ev.type === "toolcall_end") toolCall = ev.toolCall;
      if (ev.type === "done") { reason = ev.reason; usage = ev.message?.usage; const tc = ev.message?.content?.find((c) => c.type === "toolCall"); if (tc) toolCall = tc; }
    }
  }
  return { reason, text, thinking, toolCall, usage };
}
async function fullTurn(conv, content) {
  let r = await stream(conv, { kind: "user", content }); let g = 0;
  while (r.reason === "toolUse" && g++ < 6) {
    const next = await stream(conv, { kind: "tool_result", toolUseId: r.toolCall.id, content: `Wrote ${r.toolCall.arguments?.path}.` });
    next.toolCallSeen = r.toolCall; r = next;
  }
  return r;
}
const pass = (b) => (b ? "YES ✅" : "NO ❌");

try {
  for (let i = 0; i < 60 && !srvlog.includes("listening"); i++) await sleep(250);
  console.log("sidecar up.\n");

  console.log("=== codex tool loop + continuity ===");
  const t1 = await fullTurn("CX-A", "Create greeting.txt containing 'hello world'. Use write_file.");
  console.log(`  turn1 completed: ${pass(t1.reason === "stop")}  ("${t1.text.trim().slice(0, 80)}")`);
  console.log(`  tool was called with a path: ${pass(!!t1.toolCallSeen?.arguments?.path)}  (${JSON.stringify(t1.toolCallSeen?.arguments ?? {})})`);
  console.log(`  usage reported: ${pass((t1.usage?.totalTokens ?? 0) > 0)}  (${JSON.stringify(t1.usage ?? {})})`);
  const t2 = await fullTurn("CX-A", "What filename did you just create? Answer with just the filename.");
  console.log(`  turn2 remembered (continuity): ${pass(/greeting/i.test(t2.text))}  ("${t2.text.trim().slice(0, 40)}")`);

  console.log("\n=== teardown via /close ===");
  await fetch(`${BASE}/close`, { method: "POST", headers: H, body: JSON.stringify({ conversationId: "CX-A" }) });
  await sleep(600);
  console.log(`  /close tore down conversation: ${pass(srvlog.includes("closed conversation CX-A"))}`);
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  srv.kill("SIGKILL");
  if (process.env.DUMP) {
    const { writeFileSync } = await import("node:fs");
    const logFile = join(ROOT, "smoke-codex.log");
    writeFileSync(logFile, srvlog);
    console.log(`\n--- sidecar log tail (full: ${logFile}) ---\n` + srvlog.slice(-2000));
  }
  setTimeout(() => process.exit(0), 400);
}
