import { auth } from "@/lib/auth"
import { getSpamStats } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Spam counts by status, top forms by SPAM count, top users by
// submission volume. Counts only.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const stats = await getSpamStats(session)
    return ok(stats)
  } catch (err) {
    return handleApiError(err)
  }
}
