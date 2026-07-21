/** Pure-function tests: model normalization, cost math, NDJSON parsing, tokens. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, calculateCost, type Usage } from "../src/api-types.js";
import { parseLine } from "../src/bridge/stream-parser.js";
import { generateToken, normalizeOrigin } from "../src/config.js";
import { mapClaudeToolNameToClient, isClientTool } from "../src/bridge/tool-mapping.js";

test("normalizeModel: plain id string", () => {
  assert.deepEqual(normalizeModel("sonnet"), {
    id: "sonnet", provider: "anthropic",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});

test("normalizeModel: minimal object", () => {
  assert.equal(normalizeModel({ id: "opus" }).id, "opus");
  assert.equal(normalizeModel({ id: "opus" }).provider, "anthropic");
});

test("normalizeModel: rich client model passes through what matters, ignores the rest", () => {
  const m = normalizeModel({
    id: "sonnet", name: "Claude Sonnet", provider: "anthropic", api: "agent-cli-bridge",
    baseUrl: "http://x", contextWindow: 200000, maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  assert.deepEqual(m, {
    id: "sonnet", provider: "anthropic",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
});

test("normalizeModel: partial/invalid cost fields default to 0", () => {
  const m = normalizeModel({ id: "sonnet", cost: { input: 3, output: "x" } });
  assert.deepEqual(m.cost, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("normalizeModel: rejects missing/empty ids", () => {
  for (const bad of [undefined, null, "", "   ", {}, { id: "" }, { name: "x" }, 42]) {
    assert.throws(() => normalizeModel(bad), /model/);
  }
});

test("calculateCost computes per-Mtok pricing in place", () => {
  const usage: Usage = {
    input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0,
    totalTokens: 3_500_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost({ id: "m", provider: "p", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, usage);
  assert.equal(usage.cost.input, 3);
  assert.equal(usage.cost.output, 7.5);
  assert.equal(usage.cost.cacheRead, 0.6);
  assert.equal(usage.cost.total, 11.1);
});

test("parseLine: valid NDJSON object parses, junk returns null", () => {
  assert.deepEqual(parseLine('{"type":"result","subtype":"success"}'), { type: "result", subtype: "success" });
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("[SandboxDebug] noise"), null);
  assert.equal(parseLine("{not json"), null);
  assert.equal(parseLine("[1,2,3]"), null);
  assert.equal(parseLine('"just a string"'), null);
});

test("generateToken: grouped, unambiguous alphabet, unique per call", () => {
  const t = generateToken();
  assert.match(t, /^[0-9a-z]{4}(-[0-9a-z]{4}){3}$/);
  assert.doesNotMatch(t, /[ilou]/); // Crockford base32 drops the ambiguous letters
  assert.notEqual(t, generateToken());
});

test("normalizeOrigin canonicalizes case, slashes and default ports", () => {
  assert.equal(normalizeOrigin("https://App.Example.COM/"), "https://app.example.com");
  assert.equal(normalizeOrigin("  https://moonomat.com  "), "https://moonomat.com");
  assert.equal(normalizeOrigin("https://example.com:443"), "https://example.com");
  assert.equal(normalizeOrigin("http://localhost:5173/"), "http://localhost:5173");
  // Scheme-less input falls back to plain lowercase/strip (URL would parse it as a protocol).
  assert.equal(normalizeOrigin("Localhost:5173/"), "localhost:5173");
});

test("tool-mapping strips only the custom-tools MCP prefix", () => {
  assert.equal(isClientTool("mcp__custom-tools__write"), true);
  assert.equal(isClientTool("ToolSearch"), false);
  assert.equal(mapClaudeToolNameToClient("mcp__custom-tools__write"), "write");
  assert.equal(mapClaudeToolNameToClient("ToolSearch"), "ToolSearch");
});
