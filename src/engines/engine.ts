/**
 * The engine seam: one implementation per supported agent CLI.
 *
 * The conversation manager owns everything engine-agnostic — turn lifecycle,
 * SSE frame buffering/reattach, the pending-tool-result map, the idle sweeper —
 * and delegates to an Engine for the CLI-specific parts: how to spawn/resume a
 * persistent process, how to deliver a user message, and how to translate the
 * CLI's output into the Claude-API-style stream events the event bridge
 * consumes (both engines speak that shape internally; only claude's CLI emits
 * it natively).
 */
import type { ClaudeApiEvent } from "../bridge/types.js";
import type { ModelSpec, ThinkingLevel } from "../api-types.js";

/** A custom tool's schema, exposed to the model via the proxying MCP server. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CreateOpts {
  conversationId: string;
  model: ModelSpec;
  systemPrompt?: string;
  tools?: McpToolDef[];
  reasoning?: ThinkingLevel;
  sidecarPort: number;
  /** Pairing token, handed to the MCP proxy subprocess (env) so its /mcp-exec
   *  callbacks pass the same auth gate as every other client. */
  sidecarToken: string | null;
  scratchDir: string;
  /** Resume a previously-persisted CLI session from disk instead of creating a
   *  new one. Set by the client when it restores its last session after a
   *  reload/restart. */
  resume?: boolean;
}

/** Callbacks an engine uses to feed the conversation manager. */
export interface EngineIO {
  /** A Claude-API-style stream event for the current turn (drives the SSE frames). */
  event(ev: ClaudeApiEvent): void;
  /** The engine produced output — refresh the idle sweeper's keep-alive. */
  activity(): void;
  /** The engine finished processing the current input (turn ends with `stop`).
   *  `note` is visible fallback text when the turn ended abnormally — the
   *  manager surfaces it only if nothing was streamed this turn. */
  turnEnded(note?: string): void;
  /** The engine's process/transport closed. `note` is visible fallback text
   *  explaining a startup failure (surfaced only into an open, empty turn). */
  closed(note?: string): void;
}

/** A live engine process bound to one conversation. */
export interface EngineSession {
  /** Deliver a new user message (string, or Anthropic-style content blocks). */
  send(content: string | unknown[]): void;
  /** The manager closed a client-facing turn (e.g. paused on a tool call).
   *  Engines that report usage cumulatively (codex) re-baseline here so each
   *  client step carries only its own usage, not the run's running total. */
  clientTurnEnded?(): void;
  /** Force-kill the underlying process. Idempotent. */
  kill(): void;
}

export interface Engine {
  id: "claude" | "codex";
  spawn(opts: CreateOpts, io: EngineIO): EngineSession;
}

// Appended to every conversation's system prompt. The bridge is single-tool per
// turn (the manager surfaces one paused tool call at a time), so parallel tool
// use is degraded to serial regardless — but discouraging it up front keeps the
// common path clean and avoids the extra round-trips that deferral costs.
// The MCP note stops the model from narrating tool-name/plumbing discovery to
// the user: the tools the client's system prompt describes by plain name arrive
// through the "custom-tools" MCP server, so their session names carry a prefix.
export const ONE_TOOL_PER_TURN_RULE =
  "\n\nTool-use constraint: never emit more than one tool call in a single response (no parallel tool use) — wait for each tool's result before deciding the next call. Calling tools one after another across responses is fine and does not count against any limit." +
  "\n\nYour tools are provided through an MCP server named custom-tools, so their full names may carry a prefix (e.g. mcp__custom-tools__FileRead is the FileRead tool). This is expected plumbing: use the tools directly under whatever name they appear, and never mention MCP, tool schemas, tool names, or tool discovery in your replies.";
