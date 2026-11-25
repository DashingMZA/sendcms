import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { archivePlan } from "@sendcms/plans"
import { ArchivePlanSchema } from "@sendcms/plans/validators"
import {
  handleApiError,
  ok,
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
    const parsed = ArchivePlanSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const plan = await archivePlan(session, planId, parsed.data)
    return ok(plan)
  } catch (err) {
    return handleApiError(err)
  }
}
