// The 19 MCP tools, in one place. This is the SINGLE source of
// truth for tool names: the admin allowlist validator
// (@sendcms/mcp-admin) imports this list instead of keeping a second
// copy, and the Phase 11 journey + server tests assert the same set
// over the wire. If a tool is added or renamed here, the registration
// in packages/mcp/src/tools/*.ts must change with it — the server
// tests fail loudly if the two drift apart.
export const MCP_TOOL_NAMES = [
  "list_domains",
  "get_domain",
  "create_domain",
  "verify_domain",
  "delete_domain",
  "list_forms",
  "get_form",
  "create_form",
  "update_form",
  "delete_form",
  "list_submissions",
  "get_submission",
  "update_submission",
  "bulk_update_submissions",
  "delete_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
  "send_test_email",
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

// The 9 read-only tools — the set a READ-scope key sees. Mutations
// are the other 10 (FULL scope only).
export const MCP_READ_TOOL_NAMES = [
  "list_domains",
  "get_domain",
  "list_forms",
  "get_form",
  "list_submissions",
  "get_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
] as const

export function isMcpToolName(value: string): value is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(value)
}

// The tools a key of this scope may call (AIM-008): READ sees the
// 9 read-only tools, FULL sees all 19. The ROUTE uses this for its
// pre-execution refusal — a tool outside the key's scope (or an
// unknown name) is refused BEFORE the rate limiter and the usage
// recorder, exactly like the allowlist 404, so it consumes no quota
// and writes no usage row. The scope gate used to live only in tool
// registration (SDK-side), i.e. AFTER the limiter had already run.
export function toolsForScope(scope: string): readonly string[] {
  return scope === "READ" ? MCP_READ_TOOL_NAMES : MCP_TOOL_NAMES
}

export function isToolAvailableForScope(scope: string, tool: string): boolean {
  return (toolsForScope(scope) as readonly string[]).includes(tool)
}
