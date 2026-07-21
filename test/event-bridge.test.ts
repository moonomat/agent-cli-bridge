/** Event-bridge streaming tests: live partial tool arguments and redacted-
 *  thinking progress (the CLI strips reasoning text and streams only token
 *  estimates). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBridge } from "../src/bridge/event-bridge.js";
import { parseStreamingJson } from "../src/bridge/streaming-json.js";
import type { AssistantMessageEvent, ModelSpec, ThinkingContent, ToolCall } from "../src/api-types.js";

const MODEL: ModelSpec = { id: "sonnet", provider: "anthropic", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function collect() {
  const events: AssistantMessageEvent[] = [];
  return { events, sink: { push: (ev: AssistantMessageEvent) => events.push(ev) } };
}

test("parseStreamingJson: parses incomplete prefixes, undefined on junk", () => {
  assert.deepEqual(parseStreamingJson('{"path": "a.moon", "content": "box: {si'),
    { path: "a.moon", content: "box: {si" });
  assert.deepEqual(parseStreamingJson('{"a": 1, "b'), { a: 1 });
  assert.equal(parseStreamingJson(""), undefined);
  assert.equal(parseStreamingJson("  "), undefined);
  assert.equal(parseStreamingJson("[1,2"), undefined); // not an object
});

test("tool arguments stream live while the JSON is an unterminated string", () => {
  const { events, sink } = collect();
  const bridge = createEventBridge(sink, MODEL);
  bridge.handleEvent({ type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__write" } });
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path": "cube.moon", "content": "box:\\n  si' } });

  // Mid-string: strict JSON.parse would fail here, but arguments must already
  // reflect the streamed prefix so the client can render the write live.
  const mid = bridge.getOutput().content[0] as ToolCall;
  assert.deepEqual(mid.arguments, { path: "cube.moon", content: "box:\n  si" });

  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: 'ze: [1, 2, 3]"}' } });
  bridge.handleEvent({ type: "content_block_stop", index: 0 });

  const end = events.find((e) => e.type === "toolcall_end")!;
  assert.equal(end.type, "toolcall_end");
  assert.deepEqual(end.toolCall.arguments, { path: "cube.moon", content: "box:\n  size: [1, 2, 3]" });
});

test("redacted thinking surfaces a live token-count progress line", () => {
  const { events, sink } = collect();
  const bridge = createEventBridge(sink, MODEL);
  bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 } });

  let block = bridge.getOutput().content[0] as ThinkingContent;
  assert.equal(block.thinking, "Reasoning… ~50 tokens");

  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "", estimated_tokens: 2350 } });
  block = bridge.getOutput().content[0] as ThinkingContent;
  assert.equal(block.thinking, "Reasoning… ~2.4K tokens");

  bridge.handleEvent({ type: "content_block_stop", index: 0 });
  const end = events.find((e) => e.type === "thinking_end")!;
  assert.equal(end.type, "thinking_end");
  assert.equal(end.content, "Reasoned for ~2.4K tokens (the Claude CLI does not expose reasoning content).");
  assert.equal((bridge.getOutput().content[0] as ThinkingContent).thinking, end.content);
});

test("real thinking text streams verbatim and wins over token estimates", () => {
  const { events, sink } = collect();
  const bridge = createEventBridge(sink, MODEL);
  bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "", estimated_tokens: 100 } });
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "Let me count" } });
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: " the ways." } });
  bridge.handleEvent({ type: "content_block_stop", index: 0 });

  const end = events.find((e) => e.type === "thinking_end")!;
  assert.equal(end.type, "thinking_end");
  assert.equal(end.content, "Let me count the ways.");
});

test("empty thinking delta with no estimate pushes no frame", () => {
  const { events, sink } = collect();
  const bridge = createEventBridge(sink, MODEL);
  bridge.handleEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  const before = events.length;
  bridge.handleEvent({ type: "content_block_delta", index: 0,
    delta: { type: "thinking_delta", thinking: "" } });
  assert.equal(events.length, before);
  bridge.handleEvent({ type: "content_block_stop", index: 0 });
  const end = events.find((e) => e.type === "thinking_end")!;
  assert.equal(end.type, "thinking_end");
  assert.equal(end.content, "");
});
