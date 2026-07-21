/**
 * The bridge's wire format: the types a client sends (model, reasoning) and the
 * assistant-message event frames the bridge streams back. This file is the
 * source of truth for the API section in README.md — a client implements
 * against these shapes and needs no other package.
 *
 * The event shapes are wire-compatible with pi-ai's AssistantMessageEvent
 * (MIT, https://github.com/earendil-works/pi), which is what Moonomat's pi
 * agent consumes verbatim; any other client can parse them from the README
 * spec alone.
 */

// ─── Model ───────────────────────────────────────────────────────────────────

/** Per-million-token prices. Subscription-billed bridges use all-zero rates. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The normalized model the bridge works with (see {@link normalizeModel}). */
export interface ModelSpec {
  /** Passed to `claude --model`; CLI aliases (sonnet/opus/haiku) always work. */
  id: string;
  /** Echoed as message metadata. */
  provider: string;
  /** Used to fill `usage.cost` on emitted messages. */
  cost: ModelCost;
}

/**
 * Accept the `model` field of a /stream request in any of its allowed forms —
 * a plain id string, a minimal `{ id }`, or a richer client model object
 * (extra fields are ignored) — and normalize it to a full {@link ModelSpec}.
 * Cost defaults to zero: the CLI bills against the user's subscription, so a
 * per-token price would be misleading unless the client supplies one.
 */
/** Default provider for a bare model id: OpenAI-style ids (gpt-*, o3, codex-*)
 *  belong to the codex engine, everything else to claude. Clients should send
 *  an explicit `provider` — this sniff is only the string-form fallback. */
function defaultProvider(id: string): string {
  return /^gpt-|^o\d|codex/i.test(id) ? "openai" : "anthropic";
}

export function normalizeModel(input: unknown): ModelSpec {
  if (typeof input === "string" && input.trim()) {
    const id = input.trim();
    return { id, provider: defaultProvider(id), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  if (input && typeof input === "object") {
    const m = input as { id?: unknown; provider?: unknown; cost?: unknown };
    if (typeof m.id === "string" && m.id.trim()) {
      const id = m.id.trim();
      const c = (m.cost ?? {}) as Partial<Record<keyof ModelCost, unknown>>;
      const rate = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        id,
        provider: typeof m.provider === "string" && m.provider ? m.provider : defaultProvider(id),
        cost: { input: rate(c.input), output: rate(c.output), cacheRead: rate(c.cacheRead), cacheWrite: rate(c.cacheWrite) },
      };
    }
  }
  throw new Error('invalid "model": expected a model id string or an object with an "id"');
}

// ─── Reasoning ───────────────────────────────────────────────────────────────

/** Client reasoning levels accepted in a /stream request. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

// ─── Assistant message content ───────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  /** Parsed argument object; a raw string only when the streamed JSON never
   *  became parseable (clients should treat that as a malformed call). */
  arguments: Record<string, unknown> | string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export type StopReason = "stop" | "toolUse" | "length";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** The accumulated assistant message carried by every event's `partial` and by
 *  the terminal done frame's `message`. */
export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  /** API discriminator, always "agent-cli-bridge". */
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  timestamp: number;
}

/** Compute `usage.cost` in-place from the model's per-Mtok rates. */
export function calculateCost(model: ModelSpec, usage: Usage): void {
  const c = usage.cost;
  c.input = (usage.input * model.cost.input) / 1_000_000;
  c.output = (usage.output * model.cost.output) / 1_000_000;
  c.cacheRead = (usage.cacheRead * model.cost.cacheRead) / 1_000_000;
  c.cacheWrite = (usage.cacheWrite * model.cost.cacheWrite) / 1_000_000;
  c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
}

// ─── SSE event frames ────────────────────────────────────────────────────────

/** One `data:` frame of a /stream (or /reattach) SSE response. */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  /** Terminal frame of every turn. reason "toolUse" = the client must execute
   *  the message's toolCall and post the result as the next /stream input. */
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  /** /reattach control frames (never sent on a plain /stream). */
  | { type: "resume-gone" }
  | { type: "resume-empty" };

/** Where the event bridge pushes frames (the conversation manager's emit). */
export interface EventSink {
  push(ev: AssistantMessageEvent): void;
}
