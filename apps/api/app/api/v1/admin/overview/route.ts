import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getAdminOverview } from "@sendcms/platform-ops"
import { OverviewQuerySchema } from "@sendcms/platform-ops/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Real platform overview for a date range. Reads need
// VIEW_ADMIN_DASHBOARD (enforced at the route and in the service).
export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_ADMIN_DASHBOARD")
    const limited = await enforceAdminApiRateLimit(req, session.user.id)
    if (limited) return limited
    const parsed = OverviewQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const overview = await getAdminOverview(session, parsed.data)
    return ok(overview)
  } catch (err) {
    return handleApiError(err)
  }
}
