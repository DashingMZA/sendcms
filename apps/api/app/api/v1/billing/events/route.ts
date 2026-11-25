import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { listMyBillingEvents } from "@sendcms/billing"
import { BillingEventsQuerySchema } from "@sendcms/billing/validators"
import {
  ApiError,
  handleApiError,
  invalidDateFilterResponse,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// BIL-092 completion (Wave 6): the signed-in customer's own payment
// history — webhook/billing events attributed to them, newest first.
// Owner-scoped by construction: the service filters every query to
// the caller's userId, so another customer's events are never in the
// result. Same pagination/filter shape as the admin events list.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const parsed = BillingEventsQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams)
    )
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    // SRC-231: a bad `from`/`to` is a 422, not a silently dropped
    // filter — same shape as the admin events route.
    const dateError = invalidDateFilterResponse({
      from: parsed.data.from,
      to: parsed.data.to,
    })
    if (dateError) return dateError
    return ok(await listMyBillingEvents(session.user.id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
