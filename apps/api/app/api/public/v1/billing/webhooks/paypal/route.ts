import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, methodNotAllowed, ok } from "@sendcms/api-client"

// PayPal webhook — no session. Verified with PayPal's
// verify-webhook-signature endpoint against the raw body. BIL-008:
// per-IP rate-limited — verification costs two outbound PayPal calls
// per delivery, so the public endpoint must not be an amplifier.
export async function POST(req: NextRequest) {
  try {
    const rateLimited = await enforceBillingWebhookRateLimit(req, "PAYPAL")
    if (rateLimited) return rateLimited
    const rawBody = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    return ok(await handleWebhook("PAYPAL", rawBody, headers))
  } catch (err) {
    return handleApiError(err)
  }
}

// SDK-031: wrong-method requests get a JSON 405 with an Allow
// header, not Next.js's empty 405.
export const GET = () => methodNotAllowed(["POST"])
export const PUT = () => methodNotAllowed(["POST"])
export const PATCH = () => methodNotAllowed(["POST"])
export const DELETE = () => methodNotAllowed(["POST"])
export const OPTIONS = () => methodNotAllowed(["POST"])
