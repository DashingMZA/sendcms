import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getSpamStats } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// Spam counts by status, top forms by SPAM count, top users by
// submission volume. Counts only.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_CUSTOMER_DATA")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const stats = await getSpamStats(session)
    return ok(stats)
  } catch (err) {
    return handleApiError(err)
  }
}
