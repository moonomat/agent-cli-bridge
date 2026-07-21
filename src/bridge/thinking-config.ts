/**
 * Thinking effort configuration for mapping a client's reasoning level to
 * Claude CLI --effort flags.
 *
 * Maps the wire format's reasoning levels (minimal/low/medium/high/xhigh) to the
 * CLI's effort levels (low/medium/high/max). Opus and Fable models get an
 * elevated mapping where medium becomes high and high becomes max, leveraging
 * their superior reasoning capability.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 */

import type { ThinkingLevel } from "../api-types.js";

/** CLI effort levels accepted by the --effort flag */
export type CliEffortLevel = "low" | "medium" | "high" | "max";

/**
 * Standard model mapping: reasoning level -> CLI effort.
 * Standard models never receive "max" (would cause CLI error).
 */
const STANDARD_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // standard models: silently downgrade (max not supported)
};

/**
 * Elevated model mapping (Opus/Fable): shifted up for elevated reasoning.
 * These models get max capability at high/xhigh levels.
 */
const ELEVATED_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "high", // shifted: standard high
  high: "max", // shifted: maximum capability
  xhigh: "max", // elevated models get max
};

/**
 * Detect whether a model ID supports the CLI's "max" effort level.
 * Opus and Fable models qualify; substring matching keeps this
 * forward-compatible with future versions.
 *
 * @param modelId - The model identifier string
 * @returns true if the model supports elevated (max) effort
 */
export function isMaxEffortModel(modelId: string): boolean {
  return modelId.includes("opus") || modelId.includes("fable");
}

/**
 * Map a client reasoning level to a CLI effort string.
 *
 * When reasoning is undefined, returns undefined so the --effort flag is omitted
 * entirely, letting the CLI use its default behavior.
 *
 * @param reasoning - The client's reasoning level (undefined = omit flag)
 * @param modelId - Model ID for max-effort capability detection
 * @returns CLI effort level string, or undefined if flag should be omitted
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  modelId?: string,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }
  const elevated = modelId ? isMaxEffortModel(modelId) : false;
  const map = elevated ? ELEVATED_EFFORT_MAP : STANDARD_EFFORT_MAP;
  return map[reasoning];
}
