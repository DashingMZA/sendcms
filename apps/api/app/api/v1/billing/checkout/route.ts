import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { enforceBillingCheckoutRateLimit } from "@/lib/rate-limit"
import { createCheckoutSession } from "@sendcms/billing"
import { checkoutSessionSchema } from "@sendcms/billing/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Start a hosted checkout for the signed-in user. The body names
// the plan version + provider + country; the service re-reads the
// plan version from the DB and refuses free, unpublished, disabled,
// unconfigured, or country-restricted checkouts. BIL-018: per-user
// rate-limited — each checkout creates provider-side objects.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const rateLimited = await enforceBillingCheckoutRateLimit(
      req,
      session.user.id
    )
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = checkoutSessionSchema.safeParse(body)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    return ok(await createCheckoutSession(session, parsed.data))
  } catch (err) {
    return handleApiError(err)
  }
}
