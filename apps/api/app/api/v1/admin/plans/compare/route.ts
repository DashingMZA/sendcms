import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { comparePlanVersions } from "@sendcms/plans"
import { PlanVersionCompareQuerySchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_PLAN_VERSIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = PlanVersionCompareQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const diff = await comparePlanVersions(
      session,
      parsed.data.from,
      parsed.data.to
    )
    return ok(diff)
  } catch (err) {
    return handleApiError(err)
  }
}
