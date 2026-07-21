/**
 * Conversation manager (MCP-execution-proxy shape), engine-agnostic.
 *
 * One persistent CLI process per conversation — a `claude` CLI or a `codex`
 * app-server, chosen per conversation by the model's provider (see
 * {@link engineFor}) — runs the full native agentic loop and PAUSES on each
 * custom tool call (the MCP proxy blocks). The manager surfaces each paused
 * tool call to the client as a single assistant turn; the client executes the
 * tool and posts the result back, which unblocks the CLI.
 *
 * Per client step (one /stream call):
 *  - input.kind="user": deliver the user message to the live engine; stream
 *    events until it pauses on a custom tool (-> done:toolUse) or finishes
 *    (-> done:stop).
 *  - input.kind="tool_result": resolve the blocked MCP call (CLI continues);
 *    stream the next events until the next pause/finish.
 *
 * Engine-internal tools execute inside the CLI and never become client turns;
 * only calls arriving through the MCP proxy (/mcp-exec) do.
 *
 * Resilience: a turn buffers every SSE frame it emits, and a dropped client
 * socket DETACHES (rather than tears down) the conversation. A returning client
 * reattaches via handleReattach and the buffered turn is replayed/continued, so
 * a mobile background or network blip mid-turn no longer loses the conversation.
 * Abandoned conversations are reaped by an idle sweeper after GRACE_MS — but
 * reaping only frees the process: each conversation is persisted to disk by its
 * CLI, so a later /stream with `resume` re-loads it. The GRACE_MS window is
 * thus a resource knob, not a correctness boundary.
 */
import { createEventBridge, type EventBridge } from "./bridge/event-bridge.js";
import { mapClaudeToolNameToClient } from "./bridge/tool-mapping.js";
import { claudeEngine } from "./engines/claude.js";
import { codexEngine } from "./engines/codex.js";
import type { CreateOpts, Engine, EngineSession, McpToolDef } from "./engines/engine.js";
import type { ModelSpec, AssistantMessageEvent } from "./api-types.js";

export type { CreateOpts, McpToolDef };

/**
 * Pick the engine for a model: explicit provider first ("openai"/"codex" →
 * codex; "anthropic" → claude), then an id sniff as fallback for clients that
 * send a bare model id string.
 */
export function engineFor(model: ModelSpec): Engine {
  const provider = model.provider.toLowerCase();
  if (provider === "openai" || provider === "codex") return codexEngine;
  if (provider === "anthropic" || provider === "claude") return claudeEngine;
  return /^gpt-|^o\d|codex/i.test(model.id) ? codexEngine : claudeEngine;
}

export interface SseSink {
  write(line: string): void;
  end(): void;
}

interface Turn {
  bridge: EventBridge;
  /** Current client sink. Swapped on reattach; writes are gated by `live`. */
  sink: SseSink;
  /** Every SSE frame emitted this turn, retained for replay on reattach. */
  frames: string[];
  /** Whether a client is currently attached to receive live frames. */
  live: boolean;
  ended: boolean;
  /** True once a live client has received the terminal [DONE] for this turn. */
  delivered: boolean;
  resolve: () => void;
}

interface Conversation {
  session: EngineSession;
  engineId: string;
  model: ModelSpec;
  turn: Turn | null;
  /** Blocked MCP calls awaiting a client tool result, keyed by toolUseId. */
  pending: Map<string, (out: { content: string | unknown[]; isError?: boolean }) => void>;
  closed: boolean;
  /** The toolUseId whose result was most recently delivered and applied. A
   *  /stream retry can re-deliver the same tool_result (the client retries a
   *  POST whose response connection died after the body was already processed
   *  — reset pooled socket, tunnel blip); matching against this id lets the
   *  duplicate attach to the in-flight turn instead of erroring it. Cleared on
   *  each new user message. */
  lastResolvedToolUseId?: string;
  /** Last time the CLI produced output or a client touched this conversation;
   *  read by the idle sweeper to reap abandoned conversations after GRACE_MS. */
  lastSeen: number;
}

const convs = new Map<string, Conversation>();

/** How long a disconnected conversation is kept alive so a returning client can
 *  reattach and resume its turn (mobile background, network blip, reload).
 *  Junk env (NaN) must not silently disable the sweeper (`now - lastSeen > NaN`
 *  is always false), so validate and fall back. */
const GRACE_MS = ((): number => {
  const n = Number(process.env.AGENT_CLI_BRIDGE_GRACE_MS);
  return Number.isInteger(n) && n > 0 ? n : 600_000;
})();

/** Buffer a frame for replay and, if a client is attached, write it through. */
function emit(turn: Turn, ev: AssistantMessageEvent): void {
  if (turn.ended) return;
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  turn.frames.push(frame);
  if (turn.live) turn.sink.write(frame);
}

function endTurn(
  turn: Turn,
  reason: "stop" | "toolUse" | "length",
  onlyToolCallId?: string,
): void {
  if (turn.ended) return;
  const output = turn.bridge.getOutput();
  // For a tool-use pause, surface EXACTLY the one tool call the CLI paused on.
  // Claude may emit a PARALLEL batch of tool_use blocks in a single assistant
  // message, and the event bridge accumulates a toolCall for each. But the CLI
  // invokes them one at a time (it blocks on each MCP call before issuing the
  // next), and this bridge resumes one result per turn. Handing the client the
  // whole batch makes it run ahead and post results for tools whose MCP call
  // hasn't registered a `pending` entry yet -> "no pending tool call matched" ->
  // the turn is killed and the CLI hangs (the parallel-tool-use failure).
  // Filtering to the single paused id keeps the client in lockstep: the
  // remaining tools surface one at a time, each in its own turn. Non-toolCall
  // blocks (text/thinking) are always kept. The filter builds a NEW array —
  // `output.content` is left intact so any late CLI-stdout deltas for this turn
  // can't corrupt block indices.
  const content = onlyToolCallId
    ? output.content.filter(
        (c) => c.type !== "toolCall" || (c as { id?: string }).id === onlyToolCallId,
      )
    : output.content;
  const doneFrame = `data: ${JSON.stringify({ type: "done", reason, message: { ...output, content, stopReason: reason } })}\n\n`;
  turn.frames.push(doneFrame, "data: [DONE]\n\n");
  turn.ended = true;
  // Flush the terminal frames to a live client; if the client is detached they
  // stay buffered for a reattach (delivered stays false).
  if (turn.live) {
    turn.sink.write(doneFrame);
    turn.sink.write("data: [DONE]\n\n");
    turn.sink.end();
    turn.delivered = true;
  }
  turn.resolve();
}

function spawnConversation(opts: CreateOpts): Conversation {
  const engine = engineFor(opts.model);
  const conv: Conversation = {
    session: null as unknown as EngineSession, // set right below
    engineId: engine.id,
    model: opts.model,
    turn: null,
    pending: new Map(),
    closed: false,
    lastSeen: Date.now(),
  };

  conv.session = engine.spawn(opts, {
    event: (ev) => {
      if (conv.turn) conv.turn.bridge.handleEvent(ev);
    },
    activity: () => {
      conv.lastSeen = Date.now();
    },
    turnEnded: (note) => {
      const t = conv.turn;
      if (!t) return;
      if (note && t.bridge.getOutput().content.length === 0) t.bridge.ensureText(note);
      endTurn(t, "stop");
    },
    closed: (note) => {
      conv.closed = true;
      if (conv.turn && !conv.turn.ended) {
        // Closed mid-turn: surface the engine's startup-failure note if nothing
        // was streamed; a close after output flowed ends quietly.
        if (note && conv.turn.bridge.getOutput().content.length === 0) {
          conv.turn.bridge.ensureText(note);
        }
        endTurn(conv.turn, "stop");
      }
      // Delete only if the map still points at THIS conversation: the
      // interrupt-respawn path (kill + immediate respawn under the same id)
      // otherwise has the OLD process's async close event delete the NEW
      // conversation, orphaning its process and breaking its tool calls.
      if (convs.get(opts.conversationId) === conv) convs.delete(opts.conversationId);
    },
  });

  return conv;
}

/** Handle one client step. Resolves when the turn ends (pause on tool, or finish).
 *  `onAttached` hands back a detach callback bound to THIS turn, so the HTTP
 *  layer can detach the right turn on socket close (it must not detach a later
 *  turn that already replaced it). */
export async function handleStream(
  opts: CreateOpts,
  input:
    | { kind: "user"; content: string | unknown[] }
    | { kind: "tool_result"; toolUseId: string; content: string | unknown[] },
  sink: SseSink,
  onAttached?: (detach: () => void) => void,
): Promise<void> {
  let conv = convs.get(opts.conversationId);
  if (!conv) {
    conv = spawnConversation(opts);
    convs.set(opts.conversationId, conv);
  }
  conv.lastSeen = Date.now();
  console.error(`[agent-cli-bridge] ${opts.conversationId} step input=${input.kind}${input.kind === "tool_result" ? " id=" + input.toolUseId : ""}`);

  // Duplicate tool_result delivery (client retried a POST whose response
  // connection failed after the body was already applied): the CLI is already
  // continuing on this result, so make the retry the live consumer of the
  // in-flight turn — replay its buffered frames and attach, exactly like
  // /reattach — instead of erroring the conversation.
  if (
    input.kind === "tool_result" &&
    !conv.pending.has(input.toolUseId) &&
    input.toolUseId === conv.lastResolvedToolUseId &&
    conv.turn
  ) {
    console.error(`[agent-cli-bridge] ${opts.conversationId} duplicate tool_result id=${input.toolUseId} -> attaching to in-flight turn`);
    return attachSinkToTurn(conv.turn, 0, sink, onAttached);
  }

  // Make the engine ready to accept a NEW user message — input is processed
  // sequentially, so it must be idle first.
  if (input.kind === "user") {
    conv.lastResolvedToolUseId = undefined;
    if (conv.pending.size > 0) {
      // Blocked on an abandoned tool call (user stopped mid-tool, then sent a new
      // message): we can't cleanly interleave, so reset the conversation and
      // start fresh. Rare, and matches the prior tear-down-on-stop behavior.
      closeConversation(opts.conversationId);
      conv = spawnConversation(opts);
      convs.set(opts.conversationId, conv);
    } else if (conv.turn && !conv.turn.ended) {
      // A previous turn is still winding down (e.g. user stopped mid-generation).
      // Let it finish; its output stays in the CLI history but is dropped from
      // the client stream.
      const cur = conv.turn;
      await new Promise<void>((res) => { const prev = cur.resolve; cur.resolve = () => { prev(); res(); }; });
    }
  }
  const c = conv;

  return new Promise<void>((resolve) => {
    const turn: Turn = {
      bridge: createEventBridge({ push: (ev) => emit(turn, ev) }, c.model),
      sink,
      frames: [],
      live: true,
      ended: false,
      delivered: false,
      resolve,
    };
    c.turn = turn;
    onAttached?.(() => detachTurn(turn));

    if (input.kind === "user") {
      c.session.send(input.content);
    } else {
      // Deliver the tool result to the blocked MCP call -> CLI continues.
      const r = c.pending.get(input.toolUseId);
      c.pending.delete(input.toolUseId);
      if (r) {
        c.lastResolvedToolUseId = input.toolUseId;
        r({ content: input.content });
      }
      else {
        // No matching pending call: the CLI isn't (or is no longer) blocked on
        // this id. Log the mismatch and surface it instead of ending silently.
        console.error(`[agent-cli-bridge] ${opts.conversationId} tool_result for unknown id=${input.toolUseId} (pending: ${[...c.pending.keys()].join(",") || "none"})`);
        turn.bridge.ensureText(`(bridge) No pending tool call matched id ${input.toolUseId}; nothing to resume.`);
        endTurn(turn, "stop");
      }
    }
  });
}

/**
 * Attach a sink to an existing turn: replay the buffered frames the client
 * hasn't seen yet (from `cursor`), then either end (turn already complete) or
 * take over as the live sink until the turn resolves. Shared by /reattach and
 * the duplicate-tool_result path in handleStream.
 */
function attachSinkToTurn(
  turn: Turn,
  cursor: number,
  sink: SseSink,
  onAttached?: (detach: () => void) => void,
): Promise<void> {
  const from = Math.max(0, Math.min(cursor, turn.frames.length));
  for (let i = from; i < turn.frames.length; i++) sink.write(turn.frames[i]);
  if (turn.ended) {
    turn.delivered = true;
    sink.end();
    return Promise.resolve();
  }
  // Turn still in progress — attach this sink for the remaining live frames.
  turn.sink = sink;
  turn.live = true;
  onAttached?.(() => detachTurn(turn));
  return new Promise<void>((resolve) => {
    const prev = turn.resolve;
    turn.resolve = () => { prev(); resolve(); };
  });
}

/**
 * Resume delivery of the current turn to a reconnecting client. Replays buffered
 * frames from `cursor` (the count the client already received), then either ends
 * (turn already complete) or attaches the new sink for live continuation.
 *
 * Emits a single `resume-gone` control frame if the conversation no longer
 * exists (reaped / never created), or `resume-empty` if it is alive but has
 * nothing pending (the last turn was already delivered).
 */
export function handleReattach(
  conversationId: string,
  cursor: number,
  sink: SseSink,
  onAttached?: (detach: () => void) => void,
): Promise<void> {
  const conv = convs.get(conversationId);
  if (!conv || conv.closed) {
    sink.write(`data: ${JSON.stringify({ type: "resume-gone" })}\n\n`);
    sink.write("data: [DONE]\n\n");
    sink.end();
    return Promise.resolve();
  }
  conv.lastSeen = Date.now();
  const turn = conv.turn;
  if (!turn || (turn.ended && turn.delivered)) {
    sink.write(`data: ${JSON.stringify({ type: "resume-empty" })}\n\n`);
    sink.write("data: [DONE]\n\n");
    sink.end();
    return Promise.resolve();
  }
  console.error(`[agent-cli-bridge] ${conversationId} reattach cursor=${cursor}/${turn.frames.length} ended=${turn.ended}`);
  return attachSinkToTurn(turn, cursor, sink, onAttached);
}

/**
 * Called by the MCP proxy server when the CLI invokes a custom tool. Ends the
 * current turn as a tool-use turn (so the client executes the tool) and blocks
 * until the result is delivered via the next /stream call.
 */
export function handleMcpExec(
  conversationId: string,
  toolUseId: string,
  name: string,
  args: unknown,
): Promise<{ content: string | unknown[]; isError?: boolean }> {
  const conv = convs.get(conversationId);
  if (!conv) return Promise.resolve({ content: "conversation not found", isError: true });
  conv.lastSeen = Date.now();
  const clientName = mapClaudeToolNameToClient(name);
  const argObj: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const argPreview = JSON.stringify(argObj).slice(0, 200);
  console.error(`[agent-cli-bridge] ${conversationId} tool paused name=${name} id=${toolUseId} args=${argPreview} -> surfacing to client`);
  return new Promise((resolve) => {
    conv.pending.set(toolUseId, resolve);
    // Close the turn so the client executes the tool. The MCP protocol just
    // handed us the authoritative tool id + name + args, so inject them into the
    // turn output BEFORE ending it: the CLI's own stream events for this block
    // race this HTTP call and routinely lose (with the codex engine they never
    // arrive at all — tool blocks are not synthesized from notifications), which
    // would otherwise close the turn with no toolCall — the client would then
    // stop and this call would hang forever. ensureToolCall is a no-op when the
    // stream already populated it.
    if (conv.turn && !conv.turn.ended) {
      conv.turn.bridge.ensureToolCall(toolUseId, clientName, argObj);
      // Surface ONLY this tool call, even if the stdout stream accumulated a
      // sibling from a parallel batch (see endTurn) — keeps the client serial.
      endTurn(conv.turn, "toolUse", toolUseId);
      // Tell the engine a client step closed, so cumulative usage reporting
      // (codex) re-baselines and the next step reports only its own tokens.
      conv.session.clientTurnEnded?.();
    }
  });
}

/** Mark a turn's client as detached (socket dropped) without tearing down the
 *  conversation, so a reattach can resume it. Bound per-turn so a stale close
 *  from a prior turn can't detach the live one. */
function detachTurn(turn: Turn): void {
  if (!turn.ended) turn.live = false;
}

export function closeConversation(conversationId: string): void {
  const conv = convs.get(conversationId);
  if (!conv) return;
  // Settle any blocked MCP call so its /mcp-exec HTTP handler returns instead of
  // hanging, and close any open turn so its handleStream promise resolves.
  for (const resolve of conv.pending.values()) resolve({ content: "conversation closed", isError: true });
  conv.pending.clear();
  if (conv.turn && !conv.turn.ended) endTurn(conv.turn, "stop");
  if (!conv.closed) {
    conv.closed = true;
    conv.session.kill();
  }
  convs.delete(conversationId);
  console.error(`[agent-cli-bridge] closed conversation ${conversationId}`);
}

// Idle sweeper: reap conversations no client or CLI has touched for GRACE_MS, so
// a client that vanished without an explicit /close (crash, discarded mobile
// PWA) doesn't leak a CLI process indefinitely. unref so it never holds the
// process open on its own.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of convs) {
    if (now - conv.lastSeen > GRACE_MS) {
      console.error(`[agent-cli-bridge] reaping idle conversation ${id} (no activity for >${GRACE_MS}ms)`);
      closeConversation(id);
    }
  }
}, 60_000);
sweeper.unref?.();
