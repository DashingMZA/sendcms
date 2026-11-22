import { NextRequest } from "next/server"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// PayPal webhook — no session. Verified with PayPal's
// verify-webhook-signature endpoint against the raw body.
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    return ok(await handleWebhook("PAYPAL", rawBody, headers))
  } catch (err) {
    return handleApiError(err)
  }
}
