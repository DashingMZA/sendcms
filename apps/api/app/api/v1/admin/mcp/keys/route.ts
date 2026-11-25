import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listMcpKeys } from "@sendcms/mcp-admin"
import { McpKeysListQuerySchema } from "@sendcms/mcp-admin/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Every API key with its owner and its 30-day call count. Metadata
// only — the key hash is never selected, and the plaintext key is
// unrecoverable by design.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = McpKeysListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const result = await listMcpKeys(
      session,
      parsed.data.page,
      parsed.data.perPage,
      {
        search: parsed.data.search,
        userId: parsed.data.userId,
        scope: parsed.data.scope,
        revoked: parsed.data.revoked,
      }
    )
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
