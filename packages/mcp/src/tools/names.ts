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
