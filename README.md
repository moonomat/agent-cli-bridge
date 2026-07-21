# agent-cli-bridge

A small local sidecar that lets a web app use **your own AI subscriptions**
as its agent backend. It drives your locally installed, already-authenticated
agent CLIs — the **Claude Code CLI** (`claude`, Claude Pro/Max subscription)
and/or the **Codex CLI** (`codex`, ChatGPT subscription) — as subprocesses and
exposes them over HTTP/SSE: one persistent CLI process per conversation, so you
get each CLI's real agentic loop, prompt caching and compaction. The model
requested per conversation picks the engine (Claude models → `claude`, GPT
models → `codex`).

The twist: the CLI executes **no tools of its own**. Every tool the client app
defines is proxied to the model as an MCP tool; when the model calls one, the
bridge pauses the CLI, surfaces the call to the client as a normal assistant
turn, the client executes it (e.g. against an in-browser virtual filesystem)
and posts the result back, which unblocks the CLI. The bridge is app-agnostic —
[Moonomat](https://moonomat.com) is its first client, but any app can implement
the [API](#api) below.

## Quick start

**1. Have at least one agent CLI signed in** (skip if you already use one):
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) — run
`claude` once to sign in — and/or the
[Codex CLI](https://github.com/openai/codex) — run `codex login`.

**2. Install the bridge** — macOS / Linux:

```bash
curl -fsSL https://github.com/moonomat/agent-cli-bridge/releases/latest/download/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://github.com/moonomat/agent-cli-bridge/releases/latest/download/install.ps1 | iex
```

**3. Start it:**

```bash
agent-cli-bridge
```

```
[agent-cli-bridge] listening on http://127.0.0.1:8787
[agent-cli-bridge] engines: claude=ok codex=ok
[agent-cli-bridge] Pairing token: q3km-7f2x-9dwp-4hrv
```

**4. Pair your app:** in the app's bridge settings, point at
`http://127.0.0.1:8787` and paste the **pairing token**. Done.

### About the installer

The script is in this repo ([`install.sh`](./install.sh) /
[`install.ps1`](./install.ps1)) — read it first if you like. It uses your
Node.js if you have Node 20+, otherwise it downloads a private,
checksum-verified copy of the Node LTS runtime into `~/.agent-cli-bridge/`
(your system stays untouched), fetches the latest release's two JS files, and
puts an `agent-cli-bridge` launcher on your PATH (if `~/.local/bin` isn't on
your PATH yet — typical on macOS — it adds one `export PATH` line to your
shell profile and says so; Windows: adds the install dir to your user PATH).

To **update**, re-run the install one-liner. To **uninstall**, delete
`~/.agent-cli-bridge` and `~/.local/bin/agent-cli-bridge` plus the PATH line
it announced adding (Windows: `%USERPROFILE%\.agent-cli-bridge` and its
user-PATH entry). `agent-cli-bridge
--help` lists all flags.

### From source (developers)

Node 20+ required:

```bash
git clone https://github.com/moonomat/agent-cli-bridge && cd agent-cli-bridge
npm install
npm start          # or: npm run dev (watch mode)
```

`npm run build` produces the standalone bundle
(`dist/agent-cli-bridge.mjs` + `dist/mcp-proxy-server.cjs`) — the exact
artifact a release ships.

## Security model

Read this if you're deciding whether to trust the bridge — it's short.

- **Loopback only.** The bridge binds `127.0.0.1` and there is deliberately no
  flag to bind anything else. Remote use goes through a tunnel
  ([below](#remote-access)) that you set up explicitly.
- **Pairing token, mandatory.** Every endpoint — including `/health` — requires
  `Authorization: Bearer <token>`; there are no public requests. This matters
  because *any web page you visit* can send requests to a loopback port;
  without the token, a drive-by site could silently spend your subscriptions.
  The token is generated fresh per run (or fixed via `AGENT_CLI_BRIDGE_TOKEN`) and
  compared in constant time. `--no-token` disables this — local tinkering only.
- **It never sees your credentials.** The bridge doesn't read `~/.claude`,
  `~/.codex`, tokens, or keys. It only spawns the official `claude` / `codex`
  binaries, which handle their own authentication exactly as when you run them
  in a terminal.
- **The CLIs' own tools are disabled.** The claude CLI runs with
  `--permission-mode bypassPermissions`, which sounds alarming, so to be
  precise: all of its built-in file/shell/web tools (`Read`, `Write`, `Edit`,
  `Bash`, `WebFetch`, …) are disallowed. The codex CLI runs with its shell and
  view-image feature flags off, web search off, and a read-only sandbox as
  defense in depth; its MCP tool-call approval prompts are auto-allowed, which
  is safe precisely because the *only* reachable tools are the ones the client
  app registered — and those execute in the client, not on your machine.
- **Scratch, not your files.** The CLIs run in a throwaway temp directory; the
  bridge writes only per-conversation config files under your OS temp dir.
- **What the token does NOT protect:** anyone with the token has full use of
  your subscriptions through the bridge — treat it like a password
  (especially the fixed token of a public tunnel). And nothing can hide that
  *something* is listening on the port; without the token it just answers 401
  and reveals nothing else.
- **Optional hardening:** `--origin` restricts browser access to specific web
  origins on top of the token.

## Subscription & terms of use

The bridge drives the **official `claude` and `codex` CLIs**, authenticated by
**you**, on **your own machine** — it never handles your Anthropic or OpenAI
credentials, and nobody else's requests route through your accounts.

For Claude: as of mid-2026, Anthropic's docs acknowledge exactly this kind of
usage — headless `claude -p` and Agent SDK usage "draw from your
subscription's usage limits", and the pattern of connecting your local Claude
Code to another app is publicly practiced (Zed, Vibe Kanban, and others). What
Anthropic prohibits is *third parties* offering claude.ai login or routing
requests through users' subscription credentials on their behalf — which is
precisely what this design avoids.

For Codex: the CLI's ChatGPT sign-in bills usage against your ChatGPT plan's
Codex limits, and driving your local codex from another app is the same
publicly practiced pattern (the `codex app-server` protocol this bridge speaks
is the official integration surface used by OpenAI's own IDE extension).

Two caveats: both vendors have said the billing treatment of programmatic
subscription usage may change (Anthropic's metered "Agent SDK credit" plan was
announced and then paused in June 2026), and their terms reserve the right to
enforce changes without notice. Staying within your agreements is your
responsibility.

## Configuration

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--port <n>` | `AGENT_CLI_BRIDGE_PORT` | `8787` | Listen port (always on 127.0.0.1). |
| `--token <t>` | `AGENT_CLI_BRIDGE_TOKEN` | random per run, printed | Pairing token required as `Authorization: Bearer`. Set a fixed one for headless/systemd/tunnel use. |
| `--no-token` | — | off | Disable auth. Any web page you visit can then drive your subscriptions — local tinkering only. |
| `--origin <url>` (repeatable) | `AGENT_CLI_BRIDGE_ORIGINS` (comma-sep.) | any | Only accept browser requests from these origins; others get 403. Without it, any origin is accepted and the token alone is the boundary. |
| — | `AGENT_CLI_BRIDGE_HEARTBEAT_MS` | `15000` | SSE keepalive cadence (keep well under a fronting proxy's idle timeout). |
| — | `AGENT_CLI_BRIDGE_GRACE_MS` | `600000` | How long a disconnected conversation's CLI is kept alive for reattach before being reaped. |

Flags win over env vars.

## API

Everything a client needs to integrate. The TypeScript source of truth for
these shapes is [`src/api-types.ts`](./src/api-types.ts); the frames are
wire-compatible with pi-ai's `AssistantMessageEvent` (MIT), but no library is
required.

### Concepts

- **Conversation** — one persistent CLI process, keyed by your
  `conversationId` (use a UUID per chat session — the claude CLI rejects
  non-UUID session ids). The CLI holds the message history; you never resend
  it. The conversation's **engine** (claude or codex) is picked from the model
  on first spawn and is fixed for the conversation's life — switching a chat
  to the other engine's models means starting a new conversation (the history
  lives in the old CLI).
- **Turn** — one `POST /stream` call. You send *only the newest input* (a user
  message, or the result of the tool Claude just called); the bridge streams
  events until the CLI either **pauses on a tool call** (`done` with reason
  `toolUse`) or **finishes** (`done` with reason `stop`).
- **Client-executed tools** — you pass your tool schemas on every `/stream`;
  they're registered with the CLI (as MCP tools) when the conversation's
  process is first spawned. When Claude calls one, *you* execute it and post
  the result as the next `/stream` input.
- **Auth** — every endpoint (including `/health`) requires
  `Authorization: Bearer <pairing token>`. `401` means missing/wrong token.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Connection/version probe → `{ "ok": true, "service": "agent-cli-bridge", "version": "0.1.0", "engines": { "claude": "ok", "codex": "missing" } }` — engine status is `ok` \| `unauthenticated` \| `missing` |
| `POST` | `/stream` | One turn, as an SSE stream of event frames, then `data: [DONE]` |
| `POST` | `/reattach` | Re-join the current turn's stream after a dropped connection |
| `POST` | `/close` | Tear down a conversation's CLI process → `204` |
| `POST` | `/mcp-exec` | Internal (called by the bridge's own MCP proxy) — not for clients |
| `OPTIONS` | `*` | CORS preflight |

Errors: `400` malformed/incomplete body · `401` bad token · `403` origin not
allowed (when `--origin` is set) · `413` body over 25 MB · `404` unknown path.

### `POST /stream` — request body

```jsonc
{
  "conversationId": "uuid",          // REQUIRED. One persistent CLI per id.
  "model": "sonnet",                 // REQUIRED. A model id string — claude CLI aliases
                                     // (sonnet/opus/haiku) and codex model ids (gpt-…) work —
                                     // or an object:
                                     // { "id": "sonnet", "provider"?: "...", "cost"?:
                                     //   { input, output, cacheRead, cacheWrite } }  // $/Mtok, for
                                     // usage.cost on messages; defaults to 0 (subscription-billed).
                                     // `provider` picks the ENGINE: "anthropic" → claude CLI,
                                     // "openai" → codex CLI. Omitted, it is sniffed from the id
                                     // (gpt-*/o*/codex* → codex). Extra fields are ignored.
  "systemPrompt": "…",               // optional; applied when the CLI is first spawned.
  "tools": [                         // optional; registered at first spawn.
    { "name": "write", "description": "…", "inputSchema": { /* JSON Schema */ } }
  ],
  "reasoning": "medium",             // optional: minimal | low | medium | high | xhigh
  "resume": false,                   // optional: resume this id's on-disk CLI session
                                     // (after a bridge restart / client reload).
  "input": { "kind": "user", "content": "…" }
  // or, after a done:toolUse frame:
  // { "kind": "tool_result", "toolUseId": "toolu_…", "content": "…" | [blocks] }
}
```

`systemPrompt` and `tools` are only *used* when the conversation's CLI is first
spawned; sending them on every step is fine (ignored thereafter).

**Content forms.** A user `content` is a string, or an array of Anthropic-style
blocks for images:
`{ "type": "text", "text": "…" }` ·
`{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "…" } }`.
A tool_result `content` is a string, or an array of MCP-style blocks:
`{ "type": "text", "text": "…" }` ·
`{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`.

### `POST /stream` — SSE response

Standard SSE: frames separated by blank lines; comment frames (`: ping`, every
15 s) carry no `data:` line and should be skipped; the stream always terminates
with `data: [DONE]`.

Every `data:` frame is one JSON **event**. Streaming events carry `partial`,
the assistant message accumulated so far; the terminal `done` frame carries the
final `message`. The **assistant message** shape:

```jsonc
{
  "role": "assistant",
  "content": [ /* in order, any mix of: */
    { "type": "text", "text": "…" },
    { "type": "thinking", "thinking": "…", "thinkingSignature"?: "…" },
    { "type": "toolCall", "id": "toolu_…", "name": "write", "arguments": { /* per your schema */ } }
  ],
  "api": "agent-cli-bridge",
  "provider": "anthropic",
  "model": "sonnet",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
  "stopReason": "stop" | "toolUse" | "length",
  "timestamp": 1720000000000
}
```

Event frames, in the order a turn produces them:

| `type` | Extra fields | Meaning |
|---|---|---|
| `start` | `partial` | First event of the turn — begin rendering. |
| `text_start` | `contentIndex`, `partial` | A text block opened at `content[contentIndex]`. |
| `text_delta` | `contentIndex`, `delta`, `partial` | Append `delta` to that block. |
| `text_end` | `contentIndex`, `content`, `partial` | Block complete; `content` is its full text. |
| `thinking_start` / `thinking_delta` / `thinking_end` | as text | Same lifecycle for reasoning blocks. The claude CLI redacts reasoning content; when no text is exposed the block's `thinking` carries a live token-count progress line instead (e.g. `Reasoning… ~2.4K tokens`), finalized at `thinking_end`. The codex engine streams real reasoning-summary text. |
| `toolcall_start` | `contentIndex`, `partial` | A tool call opened. |
| `toolcall_delta` | `contentIndex`, `delta`, `partial` | A chunk of the call's raw argument JSON. `partial`'s `toolCall.arguments` is a best-effort parse of the incomplete JSON so far, so long argument values (e.g. a file's content) can be rendered growing live. |
| `toolcall_end` | `contentIndex`, `toolCall`, `partial` | Call complete; `toolCall.arguments` is the parsed object (a raw string only if the JSON never parsed — treat as malformed). |
| `done` | `reason`, `message` | **Terminal.** `reason: "stop"` = turn finished, wait for the next user message. `reason: "toolUse"` = execute `message`'s `toolCall` and post its result. `reason: "length"` = token limit. |
| `resume-gone` / `resume-empty` | — | `/reattach` control frames only (below). |

**The tool-call contract:** on `done` with reason `toolUse`, the message
contains exactly **one** `toolCall` (even if Claude planned several — the
bridge serializes them). Execute it, then call `/stream` again with
`input: { kind: "tool_result", toolUseId, content }`. Repeat until a `done`
with reason `stop`. Claude's internal tools (e.g. its MCP tool search) run
inside the CLI and never surface to you.

### `POST /reattach` — resume a dropped turn

If your connection drops mid-turn (mobile background, network blip), the CLI
keeps running and the turn's frames stay buffered. Reconnect with:

```jsonc
{ "conversationId": "uuid", "cursor": 42 }   // cursor = event frames already received
```

The bridge replays every frame after `cursor` and continues live — the client
sees one uninterrupted turn. Special first frames: `{"type":"resume-gone"}`
means the conversation no longer exists (expired/reaped — start fresh);
`{"type":"resume-empty"}` means nothing is pending (the turn was already fully
delivered).

**Retries are safe.** Re-POSTing a `/stream` `tool_result` whose response was
lost (reset connection, tunnel blip) does not corrupt the conversation: a
duplicate delivery of the already-applied result attaches to the in-flight
turn exactly like `/reattach`, replaying its frames from the start.

### Lifecycle

- A conversation's CLI process lives until: an explicit `/close`, the bridge
  exits, or no client/CLI activity for `AGENT_CLI_BRIDGE_GRACE_MS` (default
  10 min — the idle sweeper reaps it).
- Reaping frees the *process*, not the conversation: the CLI persists every
  session to disk, so a later `/stream` with `"resume": true` (or any respawn
  of an id the bridge has seen before) reloads it.
- Send `/close` on new-chat / backend-switch / app teardown; it's cheap and
  keeps processes from lingering for the grace window.

## Remote access

To use the bridge away from the machine it runs on (e.g. Moonomat on a tablet,
bridge on your desktop), put it behind an HTTPS tunnel. Any tunneling service
works — the bridge stays loopback-bound and the pairing token is the auth
either way; just set a **fixed** token so restarts don't rotate it. The worked
example below uses a **Cloudflare Tunnel** (free, no port-forwarding, no public
IP, TLS at the edge); Tailscale Funnel, ngrok and the like follow the same
pattern: tunnel → `http://127.0.0.1:8787`.

```bash
# once: install cloudflared (pkg.cloudflare.com), then
cloudflared tunnel login
cloudflared tunnel create agent-cli-bridge
cloudflared tunnel route dns agent-cli-bridge bridge.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: agent-cli-bridge
credentials-file: /home/<user>/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: bridge.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run the bridge with a fixed token and start the tunnel:

```bash
AGENT_CLI_BRIDGE_TOKEN=<long-random-secret> agent-cli-bridge
cloudflared tunnel run agent-cli-bridge
```

In the app, set the bridge URL to `https://bridge.example.com` and the same
token. The bridge answers CORS itself, so no edge CORS configuration is needed.
Anyone on the internet can now *reach* the URL; only the token *uses* it —
generate a long random secret (`openssl rand -hex 24`) and treat it like a
password.

### Keep it running (systemd user services)

Run as **user** services (the bridge spawns the Claude CLI, whose auth is
per-user). `~/.config/systemd/user/agent-cli-bridge.service`:

```ini
[Unit]
Description=agent-cli-bridge sidecar
After=network-online.target

[Service]
# PATH must contain the agent CLIs (claude/codex) and, if the installer used
# your system Node, the node binary too.
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin
Environment=AGENT_CLI_BRIDGE_TOKEN=<long-random-secret>
ExecStart=%h/.local/bin/agent-cli-bridge
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/cloudflared-bridge.service`:

```ini
[Unit]
Description=cloudflared tunnel for bridge.example.com
After=network-online.target agent-cli-bridge.service
Wants=agent-cli-bridge.service

[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /home/<user>/.cloudflared/config.yml tunnel run agent-cli-bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-cli-bridge cloudflared-bridge
sudo loginctl enable-linger <user>    # start at boot without a login session
journalctl --user -u agent-cli-bridge -f # live logs
```

### Optional hardening: Cloudflare Access

With token-only auth, unauthenticated junk traffic still reaches your local
Node server before being 401'd (a tiny parse surface — the token is checked
before the body is read). If you want strangers rejected **at Cloudflare's
edge** instead, add a Cloudflare Access application over the hostname with a
**Service Auth** policy and a service token; the app then sends
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers *alongside* the
Bearer token (the bridge's CORS allows both). Note Access denies anonymous
CORS preflights, so you must enable `options_preflight_bypass` on the Access
app (API-only setting) — this is the complexity the pairing token lets most
setups skip.

## How it works

```
Client (browser agent)             Bridge                          agent CLI (persistent, per conversation)
──────────────────────             ──────                          ─────────────────────────────────────────
user msg ──POST /stream──────────▶ deliver to engine ────────────▶ runs loop; calls a custom tool
   ◀── SSE: text…, toolcall, done ◀── surface turn ◀─POST /mcp-exec── (MCP proxy blocks) ⏸
client executes the tool
   ──POST /stream (tool_result)──▶ resolve the blocked call ──────▶ (unblocks) continues…
   ◀── SSE: text…, done:stop ◀────── turn ends ◀──────── result ── (waits for next message)
```

The engine seam: the `claude` engine talks the CLI's stream-json stdin/stdout;
the `codex` engine talks the app-server's JSONL JSON-RPC (thread/turn model)
and translates its notifications into the same internal event shape. Both
register the client's tools through the same blocking MCP proxy.

### Layout

```
src/
  server.ts              # entry: options, engine probing, listen, token banner
  config.ts              # flags/env -> BridgeOptions; pairing-token generation
  app.ts                 # HTTP/SSE app: auth gate, CORS, body cap, routes
  conversation.ts        # engine-agnostic conversation manager: turns, reattach
                         #   buffers, pending tool results, idle sweeper, routing
  api-types.ts           # the wire format (this README's API section, as types)
  engines/
    engine.ts             # the engine seam (spawn/send/kill + IO callbacks)
    claude.ts             # claude CLI engine (stream-json stdin/stdout)
    codex.ts              # codex app-server engine (JSONL JSON-RPC, thread/turn)
  bridge/
    mcp-proxy-server.cjs  # MCP server: blocks on tools/call, proxies to /mcp-exec
    event-bridge.ts       # internal stream events -> assistant-message event frames
    stream-parser.ts      # NDJSON line parser
    tool-mapping.ts       # MCP tool-name prefix handling
    thinking-config.ts    # reasoning level -> claude CLI --effort
    types.ts              # claude CLI stream-json wire types
    process-manager.ts    # CLI process registry + engine probing
test/                     # node:test suite (auth, CORS, normalization) — free to run
scripts/smoke-claude.mjs  # end-to-end smoke test (claude) — SPENDS subscription usage
scripts/smoke-codex.mjs   # end-to-end smoke test (codex) — SPENDS subscription usage
build.mjs                 # esbuild bundle -> dist/ (the two files a release ships)
install.sh / install.ps1  # the install one-liners (attached to each release)
.github/workflows/        # CI + tag-triggered release
```

`npm test` runs the unit suite (no CLI, no tokens spent).
`node scripts/smoke-claude.mjs` / `node scripts/smoke-codex.mjs` run the real
end-to-end loop against your CLIs.

### Known limitations

- **Single user, interactive use.** One bridge, one person's CLI auth.
- **Abort tears down the conversation.** Hitting Stop kills the CLI (clean, no
  leak), so continuity is lost after an interrupt; the next message starts
  fresh.
- **Saved-session restore is best-effort.** `resume` reloads the CLI's on-disk
  history for an id, but a client loading an *old* saved chat won't have the
  CLI's matching state beyond what the CLI persisted.
- **A conversation is bound to one engine.** The model's provider is read at
  first spawn; later `/stream` calls with a different provider's model do not
  move the history to the other CLI. Clients should start a new conversation
  when the user switches between Claude and Codex models.

## Attribution & license

[MIT](./LICENSE). Bridge internals were adapted from
[pi-claude-cli](https://github.com/rchern/pi-claude-cli) by Rebecca Chernoff
(MIT — see [`NOTICE-pi-claude-cli`](./NOTICE-pi-claude-cli)).

Not affiliated with or endorsed by Anthropic or OpenAI. "Claude" is a
trademark of Anthropic, PBC, and "Codex"/"ChatGPT" are trademarks of OpenAI —
used here descriptively to refer to the CLIs this tool drives.
