import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getMcpUsageSummary } from "@sendcms/mcp-admin"
import { McpUsageSummaryQuerySchema } from "@sendcms/mcp-admin/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// MCP usage totals: overall counts, per-tool counts, top users, and
// the last-24h error rate. Counts only.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_MCP")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = McpUsageSummaryQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    // SRC-231: a bad `from`/`to` is a 422, not a silently dropped
    // filter — the summary builder skips unparseable dates, so the
    // route rejects them before the service ever runs.
    const dateError = invalidDateFilterResponse({
      from: parsed.data.from,
      to: parsed.data.to,
    })
    if (dateError) return dateError
    const summary = await getMcpUsageSummary(session, parsed.data)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
