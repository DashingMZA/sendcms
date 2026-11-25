import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listAuditLogs } from "@sendcms/platform-ops"
import { AuditLogsQuerySchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Append-only audit history, newest first. There is no update or
// delete endpoint for audit rows, by design.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_AUDIT_LOGS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AuditLogsQuerySchema.safeParse(
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
    const result = await listAuditLogs(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
