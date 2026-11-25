import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getMySubscription, subscribeToFreePlan } from "@sendcms/plans"
import { SubscribeFreePlanSchema } from "@sendcms/plans/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// The signed-in user's own active subscription (if any). Ownership
// is the check — a user only ever sees their own row.
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    return ok(await getMySubscription(session.user.id))
  } catch (err) {
    return handleApiError(err)
  }
}

// BIL-120 (Wave 6, DSH-403 decision (a)): take the Free plan. The
// body names a plan version; the service re-reads it and refuses
// anything that is not a published free version (paid versions go
// through checkout). Creates an ACTIVE subscription via the same
// one-active-per-user transaction as the admin assign.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = SubscribeFreePlanSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await subscribeToFreePlan(session.user.id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
