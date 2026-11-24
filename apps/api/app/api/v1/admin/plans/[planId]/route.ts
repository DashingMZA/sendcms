import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getPlan } from "@sendcms/plans"
import { handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_PLAN_VERSIONS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { planId } = await params
    const plan = await getPlan(session, planId)
    return ok(plan)
  } catch (err) {
    return handleApiError(err)
  }
}
