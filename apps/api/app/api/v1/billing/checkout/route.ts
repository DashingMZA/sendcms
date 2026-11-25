import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { enforceBillingCheckoutRateLimit } from "@/lib/rate-limit"
import { countryFromHeaders, createCheckoutSession } from "@sendcms/billing"
import { checkoutSessionSchema } from "@sendcms/billing/validators"
import {
  ApiError,
  handleApiError,
  ok,
  validationErrorResponse,
} from "@sendcms/api-client"

// Start a hosted checkout for the signed-in user. The body names
// the plan version + provider + country; the service re-reads the
// plan version from the DB and refuses free, unpublished, disabled,
// unconfigured, or country-restricted checkouts. BIL-018: per-user
// rate-limited — each checkout creates provider-side objects.
// BIL-121: the geo-detected country (from the request headers) is
// passed in and enforced server-side — a claimed country that
// contradicts detection is a 422; detection is null only when the
// headers carry no usable country, and then the body's country is
// the fallback.
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
      return validationErrorResponse(parsed.error)
    }
    return ok(
      await createCheckoutSession(session, parsed.data, {
        detectedCountry: countryFromHeaders(req.headers),
        // BIL-057: the client IP, forwarded to Polar as
        // customer_ip_address (currency/tax detection). A hint only.
        clientIpAddress: getClientIp(req),
      })
    )
  } catch (err) {
    return handleApiError(err)
  }
}

// BIL-057: the client IP as seen by this request — the first
// x-forwarded-for entry (the platform sets it), else
// cf-connecting-ip / x-real-ip. Never trust a later entry.
function getClientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0].trim() || null
  return (
    req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null
  )
}
