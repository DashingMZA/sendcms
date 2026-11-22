import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type { McpAuthContext } from "../auth"

const logger = createLogger("mcp")

// Whether a tool may be registered for this request's key: the
// per-user allowlist (Phase 6) narrows what the key's scope already
// permits. null/undefined = no allowlist set, every in-scope tool is
// allowed; an explicit list = only those tools.
export function isToolAllowed(auth: McpAuthContext, tool: string): boolean {
  return auth.allowedTools == null || auth.allowedTools.includes(tool)
}

// Tool results are plain JSON text — every MCP client can read them,
// and the shape matches the service return values the REST routes
// already return.
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  }
}

// A service error becomes a tool error (isError), not a transport
// failure — the client sees "Error (404): Domain not found" and can
// report it, instead of the whole call failing. Unexpected errors are
// logged and answered generically (no stack leaks to the client).
export function errorResult(err: unknown): CallToolResult {
  if (err instanceof ApiError) {
    return {
      content: [
        { type: "text", text: `Error (${err.status}): ${err.message}` },
      ],
      isError: true,
    }
  }
  logger.error("mcp tool failed", { error: err })
  return {
    content: [{ type: "text", text: "Error: something went wrong." }],
    isError: true,
  }
}

// Runs a tool handler, converting any throw into a tool-error result.
export async function runTool(
  fn: () => Promise<unknown>
): Promise<CallToolResult> {
  try {
    return jsonResult(await fn())
  } catch (err) {
    return errorResult(err)
  }
}
