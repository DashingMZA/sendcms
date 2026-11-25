import type { BillingProvider } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import type {
  CheckoutArgs,
  CheckoutResult,
  ProviderCancelArgs,
  ProviderCancelOutcome,
  ProviderUpdateOutcome,
  VerifiedWebhook,
} from "./types"
import {
  cancelStripeSubscription,
  createStripeCheckoutSession,
  updateStripeSubscriptionPlan,
  verifyStripeWebhook,
} from "./stripe"
import {
  cancelPayPalSubscription,
  createPayPalCheckoutSession,
  updatePayPalSubscriptionPlan,
  verifyPayPalWebhook,
} from "./paypal"
import {
  cancelPolarSubscription,
  createPolarCheckoutSession,
  updatePolarSubscriptionPlan,
  verifyPolarWebhook,
} from "./polar"
import {
  cancelFreemiusSubscription,
  createFreemiusCheckoutSession,
  updateFreemiusSubscriptionPlan,
  verifyFreemiusWebhook,
} from "./freemius"
import { createGumroadCheckoutSession } from "./gumroad"

export {
  FREEMIUS_REPLAY_WINDOW_MS,
  getFreemiusPlanMapCount,
  checkFreemiusPlanPrice,
} from "./freemius"
export {
  createStripeCustomer,
  retrieveStripeCheckoutSession,
  createStripeBillingPortalSession,
} from "./stripe"
export { retrievePayPalSubscription, retrievePayPalOrder } from "./paypal"
export { fallbackEventId } from "./types"
export type {
  ProviderCancelArgs,
  ProviderCancelOutcome,
  ProviderUpdateOutcome,
} from "./types"

// Dispatcher: one entry point per operation, provider picked by id.
// Webhook verification is async because PayPal verifies over HTTP.
// Headers are normalized to single string values first (NextRequest
// headers can carry string arrays); providers only ever need one
// value each.
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

// BIL-001 / BIL-082: cancel a subscription AT the provider, so
// billing actually stops. Gumroad has no cancel API (and no
// checkout) — canceling a Gumroad-billed row fails loudly with
// 502 instead of silently flipping the local row.
export async function cancelSubscriptionAtProvider(
  provider: BillingProvider,
  args: ProviderCancelArgs
): Promise<ProviderCancelOutcome> {
  switch (provider) {
    case "STRIPE":
      return cancelStripeSubscription(args)
    case "PAYPAL":
      return cancelPayPalSubscription(args)
    case "POLAR":
      return cancelPolarSubscription(args)
    case "FREEMIUS":
      return cancelFreemiusSubscription(args)
    case "GUMROAD":
      throw new ApiError(
        "Gumroad has no subscription-cancel API, so this subscription cannot be canceled at the provider.",
        502
      )
  }
}

// BIL-089: move a provider subscription onto a new plan version
// (migration). Providers without a plan-change API (Freemius,
// Gumroad) report `updated: false` instead of throwing — the
// migration then proceeds as an explicitly SendCMS-only change.
// A provider FAILURE (not "unsupported") throws 502, so the
// migration does not silently diverge from what is billed.
export async function updateSubscriptionAtProvider(
  provider: BillingProvider,
  providerSubscriptionId: string,
  args: CheckoutArgs
): Promise<ProviderUpdateOutcome> {
  switch (provider) {
    case "STRIPE":
      return updateStripeSubscriptionPlan(providerSubscriptionId, {
        planName: args.version.planName,
        priceAmount: args.version.priceAmount,
        priceCurrency: args.version.priceCurrency,
        billingInterval: args.version.billingInterval,
        trialDays: args.version.trialDays,
      })
    case "PAYPAL":
      return updatePayPalSubscriptionPlan(providerSubscriptionId, args)
    case "POLAR":
      return updatePolarSubscriptionPlan(providerSubscriptionId, args)
    case "FREEMIUS":
      return updateFreemiusSubscriptionPlan(
        providerSubscriptionId,
        args.version
      )
    case "GUMROAD":
      return {
        updated: false,
        reason:
          "Gumroad has no subscription plan-change API, so the provider subscription keeps billing the old plan.",
      }
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
      // BIL-055 / BIL-095: Gumroad has no webhook endpoint at all
      // (no signature verification exists for it), so a dispatcher
      // call for Gumroad is a typed 501 — "not implemented" — not
      // the generic 500 a plain Error would produce via
      // handleApiError, and not a 422 (nothing about the request
      // is wrong; the capability does not exist).
      throw new ApiError("Gumroad has no webhook endpoint", 501)
  }
}
