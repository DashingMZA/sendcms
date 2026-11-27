import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getEmailJobForAdmin } from "@sendcms/notifications"
import { handleApiError, ok } from "@sendcms/api-client"

// Admin email-job detail (Seven Admin Pages, Phase C, plan §3.6).
// VIEW_JOBS (all staff, Health-page parity). 404 for unknown id.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_JOBS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { jobId } = await params
    return ok(await getEmailJobForAdmin(session, jobId))
  } catch (err) {
    return handleApiError(err)
  }
}
