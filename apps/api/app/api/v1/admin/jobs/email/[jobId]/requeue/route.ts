import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { requeueEmailJobForAdmin } from "@sendcms/notifications"
import { handleApiError, ok } from "@sendcms/api-client"

// Admin email-job requeue (Seven Admin Pages, Phase C, plan §3.6,
// Q9). MANAGE_JOBS + step-up re-auth, enforced in the service:
// guards first, step-up last, single-use — one password entry
// authorizes exactly one requeue.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_JOBS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { jobId } = await params
    return ok(await requeueEmailJobForAdmin(session, jobId))
  } catch (err) {
    return handleApiError(err)
  }
}
