#!/usr/bin/env node
// Real (proxying) MCP server. Unlike the schema-only server, this executes
// tools/call by forwarding to the sidecar over HTTP and BLOCKING until the
// sidecar returns a result (which it obtains from the client's tools).
//
// The CLI runs its full native loop and pauses here on each custom tool call,
// which is exactly the hook the conversation manager needs.
//
// argv: [schemaFile, sidecarExecUrl, conversationId]
// The schema file (owner-only, 0600) carries {tools, token}: the pairing token
// travels there — not argv (visible in ps) and not env (codex strips its env
// when spawning MCP servers). It is sent as a Bearer header so /mcp-exec passes
// the same auth gate as every other endpoint.
"use strict";
const fs = require("fs");
const readline = require("readline");
const http = require("http");

const schemaPath = process.argv[2];
const execUrl = process.argv[3]; // e.g. http://127.0.0.1:8787/mcp-exec
const conversationId = process.argv[4];
let tools = [];
let token = null;
try {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  tools = schema.tools ?? [];
  token = schema.token ?? null;
} catch { process.exit(1); }

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// POST {conversationId, toolUseId, name, args} to the sidecar; resolve with the
// tool result text. Blocks (no timeout here — the sidecar owns timeouts).
function proxyExec(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf-8");
    const u = new URL(execUrl);
    const headers = { "Content-Type": "application/json", "Content-Length": body.length };
    if (token) headers["Authorization"] = "Bearer " + token;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers },
      (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => {
          // Non-2xx bodies are plain text (401 bad token, 413 too large, …) —
          // relay them verbatim so the failure is self-diagnosing instead of a
          // cryptic JSON.parse error.
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`sidecar HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("bad sidecar response: " + e.message)); }
        });
      },
    );
    req.on("error", reject);
    req.write(body); req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "custom-tools", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    // The Claude CLI passes its tool_use id in _meta; other MCP clients (codex)
    // don't, so mint one — any unique string works, the client just echoes it
    // back with the tool result.
    const toolUseId =
      msg.params?._meta?.["claudecode/toolUseId"] ||
      "mcp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try {
      const out = await proxyExec({ conversationId, toolUseId, name, args });
      // out.content may be a string or an array of MCP content blocks
      // (text/image) — pass arrays straight through so render images reach Claude.
      const content = Array.isArray(out?.content)
        ? out.content
        : [{ type: "text", text: typeof out?.content === "string" ? out.content : JSON.stringify(out?.content ?? "") }];
      send({ jsonrpc: "2.0", id: msg.id, result: { content, isError: !!out?.isError } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "bridge proxy error: " + e.message }], isError: true } });
    }
  }
});
