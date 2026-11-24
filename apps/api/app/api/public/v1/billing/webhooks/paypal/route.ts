import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

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
