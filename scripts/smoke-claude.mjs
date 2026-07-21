// Manual end-to-end smoke test for the sidecar. Simulates a client's per-step
// loop against a freshly-spawned sidecar and checks: token auth, the tool loop,
// cross-message continuity, per-conversation teardown (/close), and mid-turn abort.
//
//   node scripts/smoke-claude.mjs            # run
//   DUMP=1 node scripts/smoke-claude.mjs     # also print the sidecar log
//
// NOTE: spends Claude subscription tokens (it drives the real CLI). Manual only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Conversation ids must be UUIDs — the claude CLI rejects anything else for
// --session-id (the web client always sends a UUID per chat session).
const CONV_A = randomUUID();
const CONV_B = randomUUID();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790, BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "smoke-test-pairing-token";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
// Deliberately the SLIM model form (a plain id string) to exercise normalization.
const MODEL = "sonnet";
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
    body: JSON.stringify({ conversationId: conv, model: MODEL, systemPrompt: SYS, tools: TOOLS, input }) });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", toolCall = null, reason = null;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const f = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = f.split("\n").find((l) => l.startsWith("data:")); if (!dl) continue;
      const d = dl.slice(5).trim(); if (d === "[DONE]") return { reason, text, toolCall };
      let ev; try { ev = JSON.parse(d); } catch { continue; }
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "toolcall_end") toolCall = ev.toolCall;
      if (ev.type === "done") { reason = ev.reason; const tc = ev.message?.content?.find((c) => c.type === "toolCall"); if (tc) toolCall = tc; }
    }
  }
  return { reason, text, toolCall };
}
async function fullTurn(conv, content) {
  let r = await stream(conv, { kind: "user", content }); let g = 0;
  while (r.reason === "toolUse" && g++ < 6) {
    r = await stream(conv, { kind: "tool_result", toolUseId: r.toolCall.id, content: `Wrote ${r.toolCall.arguments?.path}.` });
  }
  return r;
}
const pass = (b) => (b ? "YES ✅" : "NO ❌");

try {
  for (let i = 0; i < 60 && !srvlog.includes("listening"); i++) await sleep(250);
  console.log("sidecar up.\n");

  console.log("=== tool loop + continuity ===");
  const t1 = await fullTurn(CONV_A, "Create greeting.txt containing 'hello world'. Use write_file.");
  const t2 = await fullTurn(CONV_A, "What filename did you just create? One word.");
  console.log(`  turn1 completed: ${pass(t1.reason === "stop")}  ("${t1.text.trim().slice(0, 80)}")`);
  console.log(`  turn2 remembered (continuity): ${pass(/greeting/i.test(t2.text))}  ("${t2.text.trim().slice(0, 40)}")`);

  console.log("\n=== teardown via /close (durable session) ===");
  await fetch(`${BASE}/close`, { method: "POST", headers: H, body: JSON.stringify({ conversationId: CONV_A }) });
  await sleep(600);
  // /close frees the PROCESS, not the conversation: the CLI persists sessions
  // to disk, so a later /stream with the same id resumes its history (a new
  // chat uses a new id). See "Lifecycle" in README.md.
  const t3 = await fullTurn(CONV_A, "What filename did you create earlier in THIS chat? One word, or NONE.");
  console.log(`  respawn after /close resumes history: ${pass(/greeting/i.test(t3.text))}  ("${t3.text.trim().slice(0, 40)}")`);

  console.log("\n=== abort mid-turn (detach), then /close ===");
  const ac = new AbortController();
  const p = stream(CONV_B, { kind: "user", content: "Write a detailed 400-word essay about clouds. Do NOT use tools." }, ac.signal);
  await sleep(3500); ac.abort(); await p.catch(() => {}); await sleep(900);
  // A dropped socket only DETACHES the turn (kept alive for /reattach); only an
  // explicit /close tears the conversation down.
  console.log(`  abort detached (conversation kept): ${pass(!srvlog.includes(`closed conversation ${CONV_B}`))}`);
  await fetch(`${BASE}/close`, { method: "POST", headers: H, body: JSON.stringify({ conversationId: CONV_B }) });
  await sleep(400);
  console.log(`  /close tore down conversation B: ${pass(srvlog.includes(`closed conversation ${CONV_B}`))}`);
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  srv.kill("SIGKILL");
  if (process.env.DUMP) console.log("\n--- sidecar log ---\n" + srvlog.slice(-2000));
  setTimeout(() => process.exit(0), 400);
}
