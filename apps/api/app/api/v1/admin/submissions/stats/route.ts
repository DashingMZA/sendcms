import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getSpamStats } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Spam counts by status, top forms by SPAM count, top users by
// submission volume. Counts only.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const stats = await getSpamStats(session)
    return ok(stats)
  } catch (err) {
    return handleApiError(err)
  }
}
