import type { BillingProvider } from "@sendcms/database"
import type { CheckoutArgs, CheckoutResult, VerifiedWebhook } from "./types"
import { createStripeCheckoutSession, verifyStripeWebhook } from "./stripe"
import { createPayPalCheckoutSession, verifyPayPalWebhook } from "./paypal"
import { createPolarCheckoutSession, verifyPolarWebhook } from "./polar"
import {
  createFreemiusCheckoutSession,
  verifyFreemiusWebhook,
} from "./freemius"
import { createGumroadCheckoutSession } from "./gumroad"

// Dispatcher: one entry point per operation, provider picked by id.
// Webhook verification is async because PayPal verifies over HTTP
// and Freemius resolves the buyer from the DB. Headers are
// normalized to single string values first (NextRequest headers can
// carry string arrays); providers only ever need one value each.
export async function createCheckoutForProvider(
  provider: BillingProvider,
  args: CheckoutArgs
): Promise<CheckoutResult> {
  switch (provider) {
    case "STRIPE":
      return createStripeCheckoutSession(args)
    case "PAYPAL":
      return createPayPalCheckoutSession(args)
    case "POLAR":
      return createPolarCheckoutSession(args)
    case "FREEMIUS":
      return createFreemiusCheckoutSession(args)
    case "GUMROAD":
      return createGumroadCheckoutSession(args)
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value
    else if (Array.isArray(value) && value.length > 0) out[key] = value[0]
  }
  return out
}

export async function verifyWebhookForProvider(
  provider: BillingProvider,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<VerifiedWebhook> {
  const normalized = normalizeHeaders(headers)
  switch (provider) {
    case "STRIPE":
      return verifyStripeWebhook(
        rawBody,
        normalized["stripe-signature"] ?? null
      )
    case "PAYPAL":
      return verifyPayPalWebhook(rawBody, normalized)
    case "POLAR":
      return verifyPolarWebhook(rawBody, normalized)
    case "FREEMIUS":
      return verifyFreemiusWebhook(rawBody, normalized["x-signature"] ?? null)
    case "GUMROAD":
      throw new Error("Gumroad has no webhook endpoint")
  }
}
