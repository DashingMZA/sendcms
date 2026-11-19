import { resolveApiKey } from "@sendcms/api-keys"
import type { ApiKeyScope } from "@sendcms/database"

// The auth context every MCP tool call runs under: the API key that
// authenticated the request, resolved to its owner. Tools never see the
// key itself — only the userId + scope it carries.
export type McpAuthContext = {
  keyId: string
  userId: string
  scope: ApiKeyScope
}

// Bearer API key from the Authorization header. Returns null for a
// missing, malformed, unknown or revoked key — the route turns that
// into a 401 before any tool runs.
export async function resolveMcpAuth(
  req: Request
): Promise<McpAuthContext | null> {
  const header = req.headers.get("authorization")
  if (!header || !header.startsWith("Bearer ")) return null
  const key = header.slice("Bearer ".length).trim()
  if (!key) return null
  const resolved = await resolveApiKey(key)
  if (!resolved) return null
  return resolved
}
