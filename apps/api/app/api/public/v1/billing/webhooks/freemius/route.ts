import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// Freemius webhook — no session. Verified with HMAC-SHA256 of the
// raw body against the x-signature header. BIL-008: per-IP
// rate-limited like the other webhook routes.
export async function POST(req: NextRequest) {
  try {
    const rateLimited = await enforceBillingWebhookRateLimit(req, "FREEMIUS")
    if (rateLimited) return rateLimited
    const rawBody = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    return ok(await handleWebhook("FREEMIUS", rawBody, headers))
  } catch (err) {
    return handleApiError(err)
  }
}
