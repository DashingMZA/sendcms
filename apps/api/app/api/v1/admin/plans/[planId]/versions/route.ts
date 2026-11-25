import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createPlanVersion } from "@sendcms/plans"
import { CreatePlanVersionSchema } from "@sendcms/plans/validators"
import {
  created,
  handleApiError,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    const session = await requireAdminApi("MANAGE_PLANS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const { planId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = CreatePlanVersionSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const version = await createPlanVersion(session, planId, parsed.data)
    return created(version)
  } catch (err) {
    return handleApiError(err)
  }
}
