import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getPlatformHealth } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// Live platform health: real queries only, no fake uptime.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_ADMIN_DASHBOARD")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const health = await getPlatformHealth(session)
    return ok(health)
  } catch (err) {
    return handleApiError(err)
  }
}
