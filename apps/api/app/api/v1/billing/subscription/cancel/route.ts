import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { cancelMySubscription } from "@sendcms/plans"
import { CancelSubscriptionSchema } from "@sendcms/plans/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// BIL-122 / BIL-091 (Wave 6): cancel the signed-in customer's own
// subscription — immediately, or at the end of the current period
// with `cancelAtPeriodEnd`. Ownership is the check: the service
// cancels the caller's own latest subscription only; there is no id
// in the request to aim at another user's row.
//
// LOCAL ONLY: this cancels the SendCMS row, not the provider
// subscription — provider-side cancellation is Wave 8's work
// (BIL-001 / BIL-082). A paid subscription canceled here keeps
// billing at the provider until then; the dashboard says so.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = CancelSubscriptionSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await cancelMySubscription(session.user.id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
