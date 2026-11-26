import { NextRequest } from "next/server"
import { enforceBillingWebhookRateLimit } from "@/lib/rate-limit"
import { handleResendWebhookRequest } from "@sendcms/notifications"
import { handleApiError, methodNotAllowed, ok } from "@sendcms/api-client"

// Resend delivery webhook (EML-005) — no session. The Svix signature
// is verified against the RAW body (req.text(), never req.json()
// first) with RESEND_WEBHOOK_SECRET. Always 2xx on a verified event,
// including duplicates and unknown types, so Resend stops retrying.
// A failed signature is 401; a missing secret is 503 (the endpoint
// is not configured, so nothing is silently accepted unsigned).
// Per-IP rate-limited like the other webhook routes.
export async function POST(req: NextRequest) {
  try {
    const rateLimited = await enforceBillingWebhookRateLimit(req, "RESEND")
    if (rateLimited) return rateLimited
    const rawBody = await req.text()
    const result = await handleResendWebhookRequest({
      payload: rawBody,
      svixId: req.headers.get("svix-id"),
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
      secret: process.env.RESEND_WEBHOOK_SECRET,
    })
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      })
    }
    return ok({
      received: true,
      matched: result.matched,
      suppressed: result.suppressed,
    })
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
