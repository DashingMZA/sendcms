import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, methodNotAllowed, ok } from "@sendcms/api-client"

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

// SDK-031: wrong-method requests get a JSON 405 with an Allow
// header, not Next.js's empty 405.
export const GET = () => methodNotAllowed(["POST"])
export const PUT = () => methodNotAllowed(["POST"])
export const PATCH = () => methodNotAllowed(["POST"])
export const DELETE = () => methodNotAllowed(["POST"])
export const OPTIONS = () => methodNotAllowed(["POST"])
