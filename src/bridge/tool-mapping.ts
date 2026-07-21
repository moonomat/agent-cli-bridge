/**
 * Tool name handling for the bridge.
 *
 * In this design every client tool is exposed to Claude as a custom MCP tool
 * (`mcp__custom-tools__<name>`), and Claude's built-in file tools are
 * disabled. So there is no built-in name/arg mapping table — a custom tool's
 * client-facing name is just the MCP name with the prefix stripped, and its
 * arguments pass through unchanged (the client's schema defines them).
 */

/** Prefix Claude Code adds to tools from our "custom-tools" MCP server. */
export const CUSTOM_TOOLS_MCP_PREFIX = "mcp__custom-tools__";

/**
 * Whether a Claude tool name is one the client can execute. Only our custom
 * MCP tools qualify; internal Claude tools (ToolSearch, etc.) return false and
 * are filtered out of the client's event stream.
 */
export function isClientTool(claudeName: string): boolean {
  return claudeName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
}

/** Map a Claude tool name to its client-facing name (strip the MCP prefix). */
export function mapClaudeToolNameToClient(claudeName: string): string {
  return claudeName.startsWith(CUSTOM_TOOLS_MCP_PREFIX)
    ? claudeName.slice(CUSTOM_TOOLS_MCP_PREFIX.length)
    : claudeName;
}
