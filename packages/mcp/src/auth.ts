import { resolveApiKey } from "@sendcms/api-keys"
import type { ApiKeyScope } from "@sendcms/database"

// The auth context every MCP tool call runs under: the API key that
// authenticated the request, resolved to its owner. Tools never see the
// key itself — only the userId + scope it carries.
//
// `allowedTools` is the admin-set per-user allowlist (Phase 6), resolved
// by checkMcpAccess before the server is built: null/undefined = every
// tool the key's scope allows; an explicit list = only those tools (an
// empty list = no tools). Registration filters on it, so a disallowed
// tool never appears in tools/list.
export type McpAuthContext = {
  keyId: string
  userId: string
  scope: ApiKeyScope
  allowedTools?: string[] | null
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
