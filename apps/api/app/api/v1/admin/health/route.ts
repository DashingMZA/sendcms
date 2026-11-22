import { auth } from "@/lib/auth"
import { getPlatformHealth } from "@sendcms/platform-ops"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Live platform health: real queries only, no fake uptime.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const health = await getPlatformHealth(session)
    return ok(health)
  } catch (err) {
    return handleApiError(err)
  }
}
