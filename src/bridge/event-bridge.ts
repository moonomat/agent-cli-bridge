import type { ClaudeApiEvent, TrackedContentBlock } from "./types.js";
import { calculateCost } from "../api-types.js";
import type {
  AssistantMessage,
  EventSink,
  ModelSpec,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../api-types.js";
import { mapClaudeToolNameToClient, isClientTool } from "./tool-mapping.js";
import { parseStreamingJson } from "./streaming-json.js";

/**
 * Extended tracking for tool_use content blocks during streaming.
 * Stores the Claude tool name for argument translation at block_stop.
 */
interface TrackedToolBlock {
  type: "tool_use";
  index: number;
  id: string;
  name: string; // Already mapped to the client-facing name
  claudeName: string; // Original Claude name for arg translation
  arguments: Record<string, unknown>;
  partialJson: string;
}

/** Union of tracked block types for the blocks array. */
type TrackedBlock = TrackedContentBlock | TrackedToolBlock;

/**
 * The event bridge interface returned by createEventBridge.
 * handleEvent processes each Claude API streaming event and pushes
 * the appropriate assistant-message events to the stream.
 * getOutput returns the accumulated AssistantMessage.
 */
export interface EventBridge {
  handleEvent(event: ClaudeApiEvent): void;
  getOutput(): AssistantMessage;
  /** Inject/repair an executable toolCall independent of the stdout stream (see impl). */
  ensureToolCall(id: string, name: string, args: Record<string, unknown>): void;
  /** Append a synthetic text block (used to surface an otherwise-silent end). */
  ensureText(text: string): void;
}

function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}K`;
}

/**
 * Display text for a thinking block: the real reasoning text when the CLI
 * exposes it, else a live token-count progress line — the CLI redacts thinking
 * content (thinking_delta carries thinking:"" plus an incremental
 * estimated_tokens), and an empty thinking block would render as nothing,
 * leaving minutes of dead air during a long reasoning phase.
 */
function thinkingDisplay(block: TrackedContentBlock, done: boolean): string {
  if (block.text) return block.text;
  if (!block.estimatedTokens) return "";
  return done
    ? `Reasoned for ~${formatTokens(block.estimatedTokens)} tokens (the Claude CLI does not expose reasoning content).`
    : `Reasoning… ~${formatTokens(block.estimatedTokens)} tokens`;
}

/**
 * Map Claude API stop reasons to the wire format's stop reasons.
 */
function mapStopReason(
  reason: string | undefined,
): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    default:
      return "stop";
  }
}

/**
 * Create an event bridge that translates Claude API streaming events into the
 * assistant-message event frames of the wire format (see api-types.ts).
 *
 * The bridge maintains internal state to track content blocks and
 * accumulate the final AssistantMessage. It handles:
 * - text content blocks (start/delta/stop -> text_start/text_delta/text_end)
 * - message lifecycle (message_start for usage, message_delta for stop reason, message_stop for done)
 * - unsupported block types (tool_use, thinking) with warnings
 */
export function createEventBridge(
  stream: EventSink,
  model: ModelSpec,
): EventBridge {
  // Tracked content blocks indexed by Claude's content_block index
  const blocks: TrackedBlock[] = [];

  // The accumulated output message
  const output: AssistantMessage = {
    role: "assistant" as const,
    content: [] as (TextContent | ThinkingContent | ToolCall)[],
    api: "agent-cli-bridge",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  let started = false;

  function handleEvent(event: ClaudeApiEvent): void {
    // Emit start event on first message — tells the client to begin incremental rendering
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }

    switch (event.type) {
      case "message_start":
        handleMessageStart(event);
        break;
      case "content_block_start":
        handleContentBlockStart(event);
        break;
      case "content_block_delta":
        handleContentBlockDelta(event);
        break;
      case "content_block_stop":
        handleContentBlockStop(event);
        break;
      case "message_delta":
        handleMessageDelta(event);
        break;
      case "message_stop":
        handleMessageStop();
        break;
      // Unknown event types are silently ignored
    }
  }

  function handleMessageStart(event: ClaudeApiEvent): void {
    const usage = event.message?.usage;
    if (usage) {
      output.usage.input = usage.input_tokens ?? 0;
      output.usage.output = usage.output_tokens ?? 0;
      output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens =
        output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
  }

  function handleContentBlockStart(event: ClaudeApiEvent): void {
    const blockType = event.content_block?.type;

    if (blockType === "text") {
      const block: TrackedContentBlock = {
        type: "text",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      output.content.push({ type: "text" as const, text: "" });

      stream.push({
        type: "text_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "thinking") {
      // Stream thinking so a long reasoning phase shows as live progress instead
      // of dead air — Claude Code thinks by default (even with effort off), and
      // that thinking can run for minutes before the first visible token. The
      // CLI redacts the reasoning text (thinking_delta carries thinking:"" plus
      // an incremental estimated_tokens), so the handlers below forward the real
      // text when present and a token-count progress line otherwise (see
      // thinkingDisplay).
      const block: TrackedContentBlock = {
        type: "thinking",
        text: "",
        index: event.index ?? 0,
      };
      blocks.push(block);
      output.content.push({ type: "thinking" as const, thinking: "" });

      stream.push({
        type: "thinking_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else if (blockType === "tool_use") {
      const claudeName = event.content_block!.name!;

      // Skip internal Claude Code tools (ToolSearch, Task, Agent, etc.)
      // that the client cannot execute — only emit client tools
      if (!isClientTool(claudeName)) {
        return;
      }

      const clientName = mapClaudeToolNameToClient(claudeName);
      const id = event.content_block!.id!;

      const block: TrackedToolBlock = {
        type: "tool_use",
        index: event.index ?? 0,
        id,
        name: clientName,
        claudeName,
        arguments: {},
        partialJson: "",
      };
      blocks.push(block);
      output.content.push({
        type: "toolCall" as const,
        id,
        name: clientName,
        arguments: {},
      } as ToolCall);

      stream.push({
        type: "toolcall_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    }
    // Unknown block types silently ignored
  }

  function handleContentBlockDelta(event: ClaudeApiEvent): void {
    const deltaType = event.delta?.type;

    if (deltaType === "text_delta" && event.delta!.text != null) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "text") {
        block.text += event.delta!.text;
        const contentBlock = output.content[idx] as TextContent;
        contentBlock.text = block.text;

        stream.push({
          type: "text_delta",
          contentIndex: idx,
          delta: event.delta!.text,
          partial: output,
        });
      }
    } else if (
      deltaType === "thinking_delta" &&
      event.delta!.thinking != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        const text = event.delta!.thinking;
        if (text) {
          block.text += text;
        } else if (event.delta!.estimated_tokens) {
          // Redacted reasoning: no text, only an incremental token estimate.
          block.estimatedTokens =
            (block.estimatedTokens ?? 0) + event.delta!.estimated_tokens;
        } else {
          return; // empty delta with no estimate — nothing to render
        }
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinking = thinkingDisplay(block, false);

        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: text,
          partial: output,
        });
      }
    } else if (
      deltaType === "input_json_delta" &&
      event.delta!.partial_json != null
    ) {
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "tool_use") {
        block.partialJson += event.delta!.partial_json;

        // Parse the incomplete JSON prefix so arguments render live while they
        // stream (a long file write stays an unterminated string until the
        // block's final quote — strict parsing would show nothing the whole
        // time). On failure keep the previous arguments.
        const parsed = parseStreamingJson(block.partialJson);
        if (parsed) {
          block.arguments = parsed;
          (output.content[idx] as any).arguments = parsed;
        }

        stream.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: event.delta!.partial_json,
          partial: output,
        });
      }
    } else if (
      deltaType === "signature_delta" &&
      event.delta!.signature != null
    ) {
      // Accumulate signature on the thinking block
      const idx = blocks.findIndex((b) => b.index === event.index);
      if (idx === -1) return;

      const block = blocks[idx];
      if (block.type === "thinking") {
        const contentBlock = output.content[idx] as ThinkingContent;
        contentBlock.thinkingSignature =
          (contentBlock.thinkingSignature || "") + event.delta!.signature;
      }
    }
  }

  function handleContentBlockStop(event: ClaudeApiEvent): void {
    const idx = blocks.findIndex((b) => b.index === event.index);
    if (idx === -1) return;

    const block = blocks[idx];
    // Clean up the tracking index from the block (no longer needed)
    delete (block as any).index;

    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: idx,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      const contentBlock = output.content[idx] as ThinkingContent;
      contentBlock.thinking = thinkingDisplay(block, true);
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: contentBlock.thinking,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      // Final JSON parse. A tool called with NO arguments (e.g. render) emits
      // no input_json_delta, so partialJson stays "". Treat that as {} — a
      // client's schema validation typically requires an object, and "" fails
      // with "root: must be object". This matches Anthropic's native API, which
      // yields {} for empty tool input.
      let finalArgs: Record<string, unknown> | string;
      const isEmptyInput = block.partialJson.trim() === "";
      try {
        finalArgs = JSON.parse(isEmptyInput ? "{}" : block.partialJson);
      } catch {
        finalArgs = isEmptyInput ? {} : block.partialJson;
      }

      // Update output.content with final arguments
      const contentBlock = output.content[idx] as ToolCall;
      (contentBlock as any).arguments = finalArgs;

      // ToolCall.arguments is normally an object, but we intentionally emit a
      // raw string when JSON parse fails completely — clients handle string
      // arguments as a malformed call at runtime.
      const toolCall = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: finalArgs,
      } as ToolCall;

      stream.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall,
        partial: output,
      });
    }
  }

  function handleMessageDelta(event: ClaudeApiEvent): void {
    if (event.delta?.stop_reason) {
      output.stopReason = mapStopReason(event.delta.stop_reason);
    }

    const usage = event.usage;
    if (usage) {
      if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
      if (usage.output_tokens != null)
        output.usage.output = usage.output_tokens;
      output.usage.totalTokens =
        output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
  }

  function handleMessageStop(): void {
    // No-op: the done event is pushed by the conversation manager (endTurn).
    // Pushing done here (synchronously) prevents the client from executing tools.
  }

  /**
   * Guarantee the output carries an executable toolCall for `id`, WITHOUT relying
   * on the CLI-stdout stream events for this block having been parsed yet. Called
   * from the MCP-proxy path (handleMcpExec), which holds the authoritative tool
   * id + name + args from the MCP protocol — those two channels race, and with
   * reasoning off the HTTP call routinely arrives first, leaving the streamed
   * reconstruction empty.
   *
   * - toolCall already present with non-empty args -> leave it (normal path).
   * - present but with empty args (a partial stream race)   -> fill the args in.
   * - absent (a full stream race)                           -> add it.
   */
  function ensureToolCall(id: string, name: string, args: Record<string, unknown>): void {
    const existing = output.content.find(
      (c): c is ToolCall => c.type === "toolCall" && (c as ToolCall).id === id,
    );
    if (existing) {
      const cur = existing.arguments as unknown;
      const isEmpty =
        cur == null ||
        (typeof cur === "string" && cur.trim() === "") ||
        (typeof cur === "object" && !Array.isArray(cur) && Object.keys(cur as object).length === 0);
      if (isEmpty && args && Object.keys(args).length > 0) {
        existing.arguments = args;
      }
      return;
    }
    output.content.push({ type: "toolCall", id, name, arguments: args ?? {} } as ToolCall);
  }

  function ensureText(text: string): void {
    output.content.push({ type: "text", text } as TextContent);
  }

  return {
    handleEvent,
    getOutput: () => output,
    ensureToolCall,
    ensureText,
  };
}
