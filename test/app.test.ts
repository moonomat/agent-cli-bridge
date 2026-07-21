/**
 * Request-pipeline tests: auth gate, CORS/origin allowlist, body cap, /health.
 * These run the real HTTP app but never a real `claude` process — no request
 * here reaches a CLI spawn (401/400/403/413 all short-circuit first).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBridgeApp, type AppOptions } from "../src/app.js";

const TOKEN = "test-pairing-token-1234";
const servers: Server[] = [];

async function startApp(overrides: Partial<AppOptions> = {}): Promise<string> {
  const server = createBridgeApp({
    token: TOKEN,
    origins: [],
    heartbeatMs: 15_000,
    maxBodyBytes: 64 * 1024,
    scratchDir: join(tmpdir(), "agent-cli-bridge-test-scratch"),
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

after(() => { for (const s of servers) s.close(); });

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { "Content-Type": "application/json" };

test("/health requires the token too (no public requests) and reports service + version", async () => {
  const base = await startApp();
  const anon = await fetch(`${base}/health`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${base}/health`, { headers: auth });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string; version: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, "agent-cli-bridge");
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test("token gate: missing / malformed / wrong tokens are 401 with a hint", async () => {
  const base = await startApp();
  const attempts: Record<string, string>[] = [
    {},
    { Authorization: "Bearer " },
    { Authorization: "Bearer wrong-token" },
    { Authorization: TOKEN }, // missing Bearer prefix
  ];
  for (const headers of attempts) {
    const res = await fetch(`${base}/stream`, { method: "POST", headers: { ...json, ...headers }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /token/);
  }
});

test("token gate: valid token reaches the handler (400 on incomplete body)", async () => {
  const base = await startApp();
  const res = await fetch(`${base}/stream`, { method: "POST", headers: { ...json, ...auth }, body: "{}" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /conversationId/);
});

test("token gate applies to /reattach, /close and /mcp-exec too", async () => {
  const base = await startApp();
  for (const path of ["/reattach", "/close", "/mcp-exec"]) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: json, body: "{}" });
    assert.equal(res.status, 401, path);
  }
  // With the token: /close on an unknown conversation is a 204 no-op.
  const ok = await fetch(`${base}/close`, {
    method: "POST", headers: { ...json, ...auth },
    body: JSON.stringify({ conversationId: "does-not-exist" }),
  });
  assert.equal(ok.status, 204);
});

test("--no-token mode disables the gate", async () => {
  const base = await startApp({ token: null });
  const res = await fetch(`${base}/stream`, { method: "POST", headers: json, body: "{}" });
  assert.equal(res.status, 400); // straight to validation, no 401
});

test("model normalization rejects a model without an id", async () => {
  const base = await startApp();
  const res = await fetch(`${base}/stream`, {
    method: "POST", headers: { ...json, ...auth },
    body: JSON.stringify({ conversationId: "c1", model: { name: "no id" }, input: { kind: "user", content: "x" } }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /model/);
});

test("oversized bodies are rejected with 413", async () => {
  const base = await startApp({ maxBodyBytes: 1024 });
  const res = await fetch(`${base}/stream`, {
    method: "POST", headers: { ...json, ...auth },
    body: JSON.stringify({ pad: "x".repeat(4096) }),
  }).catch(() => null);
  // The server destroys the socket after replying; some fetch impls surface
  // that as a network error instead of the 413 response — both are a rejection.
  if (res) assert.equal(res.status, 413);
});

test("a JSON body of `null` is handled, not a crash (regression: unhandled rejection)", async () => {
  const base = await startApp();
  for (const path of ["/mcp-exec", "/stream", "/reattach", "/close"]) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { ...json, ...auth }, body: "null" });
    assert.ok(res.status === 400 || res.status === 204, `${path} → ${res.status}`);
  }
  // The process survived: /health still answers.
  const alive = await fetch(`${base}/health`, { headers: auth });
  assert.equal(alive.status, 200);
});

test("/mcp-exec validates conversationId and name", async () => {
  const base = await startApp();
  const res = await fetch(`${base}/mcp-exec`, {
    method: "POST", headers: { ...json, ...auth },
    body: JSON.stringify({ toolUseId: "t1" }),
  });
  assert.equal(res.status, 400);
});

test("origin allowlist matches case-insensitively and ignores trailing slashes", async () => {
  const base = await startApp({ origins: ["https://App.Example.COM/"] });
  const res = await fetch(`${base}/stream`, {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
});

test("preflight reflects requested headers so free-form extra headers pass CORS", async () => {
  const base = await startApp();
  const res = await fetch(`${base}/stream`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization,x-api-key",
    },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-api-key/);
});

test("origin allowlist: allowed origins get CORS, others get 403", async () => {
  const base = await startApp({ origins: ["https://app.example.com"] });

  const allowed = await fetch(`${base}/stream`, {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.match(allowed.headers.get("access-control-allow-headers") ?? "", /Authorization/);

  const denied = await fetch(`${base}/stream`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.net", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  // POSTs from a disallowed origin are rejected outright, even with the token.
  const deniedPost = await fetch(`${base}/close`, {
    method: "POST", headers: { ...json, ...auth, Origin: "https://evil.example.net" }, body: "{}",
  });
  assert.equal(deniedPost.status, 403);

  // Non-browser requests (no Origin) are unaffected by the allowlist.
  const noOrigin = await fetch(`${base}/close`, { method: "POST", headers: { ...json, ...auth }, body: "{}" });
  assert.equal(noOrigin.status, 204);
});

test("default (no allowlist) reflects any origin — the token is the boundary", async () => {
  const base = await startApp();
  const res = await fetch(`${base}/stream`, {
    method: "OPTIONS",
    headers: { Origin: "https://anything.example.org", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://anything.example.org");
});
