import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listMcpUsage } from "@sendcms/mcp-admin"
import { McpUsageListQuerySchema } from "@sendcms/mcp-admin/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Paginated MCP tool-call history, newest first. Counts only —
// request arguments and results are never recorded.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = McpUsageListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    // SRC-231: a bad `from`/`to` is a 422, not a silently dropped
    // filter — the service builders skip unparseable dates, so the
    // route rejects them before the service ever runs.
    const dateError = invalidDateFilterResponse({
      from: parsed.data.from,
      to: parsed.data.to,
    })
    if (dateError) return dateError
    const result = await listMcpUsage(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
