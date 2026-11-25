import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { reconcileCheckout } from "@sendcms/billing"
import { reconcileCheckoutSchema } from "@sendcms/billing/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Reconcile a paid-but-unprovisioned checkout (BIL-016 / BIL-052):
// the customer (or an admin on their behalf, from the attempts
// list) re-reads the checkout from the provider and activates it
// through the same idempotent activation the webhook uses. The
// body names the provider + provider checkout id; the service
// proves the checkout was paid by THIS user before activating.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = reconcileCheckoutSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }
    return ok(await reconcileCheckout(session.user.id, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
