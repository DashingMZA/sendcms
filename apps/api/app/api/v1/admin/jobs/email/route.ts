import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { listEmailJobsForAdmin } from "@sendcms/notifications"
import { AdminEmailJobListQuerySchema } from "@sendcms/notifications/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Admin email-job list (Seven Admin Pages, Phase C, plan §3.6) —
// the Jobs page Queue section. VIEW_JOBS (all staff, Health-page
// parity). Filters: status tab, type, owner search, page.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_JOBS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = AdminEmailJobListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await listEmailJobsForAdmin(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
