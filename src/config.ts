/**
 * Startup configuration: CLI flags + AGENT_CLI_BRIDGE_* env vars (flags win).
 * The pairing token is mandatory by design — it is the bridge's security
 * boundary (any web page can reach a loopback port; only the paired client
 * knows the token). `--no-token` exists solely for local tinkering.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";

export function bridgeEnv(name: string): string | undefined {
  return process.env[`AGENT_CLI_BRIDGE_${name}`];
}

export interface BridgeOptions {
  port: number;
  /** SSE keepalive cadence; see app.ts for why it must stay well under a
   *  fronting proxy's idle-reap window. */
  heartbeatMs: number;
  /** Bearer token required on every endpoint (incl. /health); null = --no-token. */
  token: string | null;
  /** True when the token was generated for this run (printed at startup). */
  tokenGenerated: boolean;
  /** CORS origin allowlist; empty = reflect any Origin (the token is the boundary). */
  origins: string[];
  /** Request bodies larger than this are rejected with 413. */
  maxBodyBytes: number;
}

export const USAGE = `agent-cli-bridge — drive your local agent CLIs (Claude Code, Codex) over HTTP/SSE

Usage: agent-cli-bridge [options]

Options:
  --port <n>       Port to listen on (loopback only). Default 8787.
  --token <t>      Fixed pairing token (for headless/systemd/tunnel use).
                   Default: a random token, printed at startup.
  --no-token       Disable auth entirely. Any web page you visit can then
                   drive your subscriptions — local tinkering only.
  --origin <url>   Only accept browser requests from this origin (repeatable).
                   Default: any origin (the pairing token is the boundary).
  --help           Show this help.

Environment (flags win): AGENT_CLI_BRIDGE_PORT, AGENT_CLI_BRIDGE_TOKEN,
AGENT_CLI_BRIDGE_ORIGINS (comma-separated), AGENT_CLI_BRIDGE_HEARTBEAT_MS.
`;

/** Crockford-base32 pairing token, grouped for readability: XXXX-XXXX-XXXX-XXXX. */
export function generateToken(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; // no i/l/o/u
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += alphabet[bytes[i] % 32];
  return s.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * Canonicalize a web origin so allowlist entries compare equal to the
 * browser's Origin header regardless of case, trailing slashes, or default
 * ports. Used on BOTH sides of the check (config parsing and the incoming
 * header) — one helper so the two normalizations can't drift.
 */
export function normalizeOrigin(u: string): string {
  const trimmed = u.trim();
  try {
    const origin = new URL(trimmed).origin;
    // A scheme-less value like "localhost:5173" parses as protocol "localhost:"
    // with origin "null" — fall through to the plain normalization for those.
    if (origin !== "null") return origin.toLowerCase();
  } catch { /* not URL-parseable — normalize as plain text */ }
  return trimmed.replace(/\/+$/, "").toLowerCase();
}

/** Parse a positive integer from a flag/env string; warn and fall back on junk
 *  (Number("8787x") is NaN — NaN ports crash listen(), a NaN heartbeat makes
 *  setInterval fire every ~1ms). */
function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[agent-cli-bridge] ignoring invalid ${name}="${raw}" — using ${fallback}`);
  return fallback;
}

export function resolveOptions(argv: string[] = process.argv.slice(2)): BridgeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      token: { type: "string" },
      "no-token": { type: "boolean" },
      origin: { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const flagOrigins = (values.origin ?? []).map(normalizeOrigin).filter(Boolean);
  const envOrigins = (bridgeEnv("ORIGINS") ?? "")
    .split(",").map(normalizeOrigin).filter(Boolean);
  const origins = flagOrigins.length > 0 ? flagOrigins : envOrigins;

  let token: string | null;
  let tokenGenerated = false;
  if (values["no-token"]) {
    token = null;
  } else {
    token = values.token || bridgeEnv("TOKEN") || null;
    if (!token) {
      token = generateToken();
      tokenGenerated = true;
    }
  }

  return {
    port: positiveInt(values.port ?? bridgeEnv("PORT"), "port", 8787),
    heartbeatMs: positiveInt(bridgeEnv("HEARTBEAT_MS"), "AGENT_CLI_BRIDGE_HEARTBEAT_MS", 15_000),
    token,
    tokenGenerated,
    origins,
    // 25 MB comfortably fits the largest legitimate payload — a single
    // 2048×2048 PNG tool-result image is ≤ ~16 MB as base64 — while bounding
    // what one request can make the bridge buffer in memory.
    maxBodyBytes: 25 * 1024 * 1024,
  };
}
