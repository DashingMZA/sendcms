import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getSystemSummary } from "@sendcms/platform-ops"
import { handleApiError, ok } from "@sendcms/api-client"

// The platform's own facts: runtime versions, env presence (never
// values), and the config.json emergency flag.
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_ADMIN_DASHBOARD")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const summary = await getSystemSummary(session)
    return ok(summary)
  } catch (err) {
    return handleApiError(err)
  }
}
