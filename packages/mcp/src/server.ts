import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { McpAuthContext } from "./auth"
import { registerAnalyticsTools } from "./tools/analytics"
import { registerDomainTools } from "./tools/domains"
import { registerFormTools } from "./tools/forms"
import { registerInboxTools } from "./tools/inbox"
import { registerNotificationTools } from "./tools/notifications"

// One McpServer per request (stateless transport — ADR 0009): the tools
// close over this request's auth context, so a key can only ever see
// its own owner's data. Read-only tools register for every key;
// mutations only when the key's scope is FULL (the register functions
// enforce that themselves).
export function createMcpServer(auth: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "sendcms",
    version: "0.1.0",
  })
  registerDomainTools(server, auth)
  registerFormTools(server, auth)
  registerInboxTools(server, auth)
  registerAnalyticsTools(server, auth)
  registerNotificationTools(server, auth)
  return server
}

export type { McpAuthContext }
