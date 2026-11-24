import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { getPlanVersion } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string; versionId: string }> }
) {
  try {
    const session = await requireAdminApi("VIEW_PLAN_VERSIONS")
    const rateLimited = await enforceAdminApiRateLimit(_req, session.user.id)
    if (rateLimited) return rateLimited
    const { planId, versionId } = await params
    const version = await getPlanVersion(session, versionId)
    if (version.planId !== planId) {
      throw new ApiError("Plan version not found", 404)
    }
    return ok(version)
  } catch (err) {
    return handleApiError(err)
  }
}
