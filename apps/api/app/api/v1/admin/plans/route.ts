import { NextRequest } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { createPlan, listPlans } from "@sendcms/plans"
import {
  CreatePlanSchema,
  PlanListQuerySchema,
} from "@sendcms/plans/validators"
import {
  created,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

export async function GET(req: NextRequest) {
  try {
    const session = await requireAdminApi("VIEW_PLAN_VERSIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const parsed = PlanListQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const plans = await listPlans(session, parsed.data)
    return ok(plans)
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MANAGE_PLANS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = CreatePlanSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    const plan = await createPlan(session, parsed.data)
    return created(plan)
  } catch (err) {
    return handleApiError(err)
  }
}
