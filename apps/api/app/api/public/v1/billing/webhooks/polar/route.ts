import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// Polar webhook — no session. Verified with Polar's validateEvent
// against the raw body. BIL-008: per-IP rate-limited like the other
// webhook routes.
export async function POST(req: NextRequest) {
  try {
    const rateLimited = await enforceBillingWebhookRateLimit(req, "POLAR")
    if (rateLimited) return rateLimited
    const rawBody = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    return ok(await handleWebhook("POLAR", rawBody, headers))
  } catch (err) {
    return handleApiError(err)
  }
}
