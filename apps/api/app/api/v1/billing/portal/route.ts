import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { createBillingPortalSession } from "@sendcms/billing"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Billing Portal (BIL-017): a Stripe-hosted session for the
// signed-in user to manage payment methods and cancel at Stripe.
// Requires a stored Stripe Customer id — the service 422s when
// the user has never paid through Stripe.
export async function POST(_req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    return ok(await createBillingPortalSession(session.user.id))
  } catch (err) {
    return handleApiError(err)
  }
}
