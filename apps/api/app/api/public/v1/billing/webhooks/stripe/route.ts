import { NextRequest } from "next/server"
import { handleWebhook } from "@sendcms/billing"
import { handleApiError, ok } from "@sendcms/api-client"

// Stripe webhook — no session. The signature is verified against
// the RAW body (req.text(), never req.json() first). Always 2xx on
// a verified event, including duplicates, so Stripe stops retrying.
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    return ok(await handleWebhook("STRIPE", rawBody, headers))
  } catch (err) {
    return handleApiError(err)
  }
}
