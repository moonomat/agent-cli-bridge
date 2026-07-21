import { parse as parsePartial } from "partial-json";

/**
 * Parse a potentially-incomplete JSON prefix as streamed by the Anthropic API's
 * input_json_delta events, so a tool call's arguments can be rendered live
 * while they stream (e.g. watching a long file's content grow) instead of
 * appearing only when the block completes.
 *
 * Returns undefined when nothing can be parsed yet (caller keeps its previous
 * value). The input is always a prefix of well-formed JSON, so partial-json's
 * completion is reliable; this never throws.
 */
export function parseStreamingJson(
  partialJson: string,
): Record<string, unknown> | undefined {
  if (partialJson.trim() === "") return undefined;
  try {
    const parsed: unknown = parsePartial(partialJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
