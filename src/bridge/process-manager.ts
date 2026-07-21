/**
 * CLI process registry + startup validation.
 *
 * The engines spawn the persistent CLI processes; this module tracks them so
 * they can be force-killed on server shutdown, and probes which agent CLIs
 * (claude, codex) are present and authenticated at startup — reported in
 * /health so clients can enable only the available model families.
 */

import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Force-kill a subprocess via SIGKILL. No-ops if already dead.
 * Cross-platform safe (Node maps SIGKILL to forceful termination on Windows).
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active CLI subprocesses, for teardown on server exit. */
const activeProcesses = new Set<ChildProcess>();

/** Track a subprocess; auto-removed from the registry when it exits. */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/** Force-kill all registered subprocesses. Safe to call multiple times. */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) forceKillProcess(proc);
  activeProcesses.clear();
}

/** One engine CLI's availability, as reported in /health. */
export type EngineStatus = "ok" | "unauthenticated" | "missing";

export interface EngineStatuses {
  claude: EngineStatus;
  codex: EngineStatus;
}

function probe(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Probe which agent CLIs are installed and authenticated. Auth checks are
 *  best-effort warnings — the definitive failure surfaces on first use. */
export function probeEngines(): EngineStatuses {
  const claude: EngineStatus = !probe("claude --version")
    ? "missing"
    : probe("claude auth status")
      ? "ok"
      : "unauthenticated";
  const codex: EngineStatus = !probe("codex --version")
    ? "missing"
    : probe("codex login status")
      ? "ok"
      : "unauthenticated";
  return { claude, codex };
}

let probeCache: { at: number; statuses: EngineStatuses } | null = null;

/** Cached probeEngines for /health: fresh enough that signing a CLI in after
 *  bridge startup is picked up on the next connection check (no restart), but
 *  cached so health pings don't spawn four subprocesses each. */
export function probeEnginesCached(ttlMs = 60_000): EngineStatuses {
  if (!probeCache || Date.now() - probeCache.at > ttlMs) {
    probeCache = { at: Date.now(), statuses: probeEngines() };
  }
  return probeCache.statuses;
}
