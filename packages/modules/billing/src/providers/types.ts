import type { BillingInterval } from "@sendcms/database"

// Shared types for the billing provider clients. Each provider module
// translates its own checkout/webhook API into these shapes so the
// service never deals with provider-specific payloads.

export type PlanVersionForCheckout = {
  id: string
  planId: string
  planName: string
  priceAmount: number | null
  priceCurrency: string
  billingInterval: BillingInterval
  trialDays: number
}

export type CheckoutCustomer = {
  userId: string
  email: string
  name: string | null
}

export type CheckoutArgs = {
  version: PlanVersionForCheckout
  customer: CheckoutCustomer
  successUrl: string
  cancelUrl: string
}

export type CheckoutResult = {
  checkoutUrl: string
  providerCheckoutId?: string
}

// A webhook event translated into the one thing the service can act
// on. Providers that cannot resolve the buyer/plan from the event
// return `ignored` and the service only logs it.
export type NormalizedBillingEvent =
  | {
      kind: "checkout-completed"
      userId: string
      planVersionId: string
      providerSubscriptionId: string
      periodEnd: Date | null
    }
  | {
      kind: "payment-succeeded"
      providerSubscriptionId: string
      periodEnd: Date | null
    }
  | { kind: "subscription-canceled"; providerSubscriptionId: string }
  | { kind: "ignored" }

export type VerifiedWebhook = {
  eventId: string
  eventType: string
  event: NormalizedBillingEvent
}

/** One-time plans have no recurring interval. */
export function isRecurring(version: PlanVersionForCheckout): boolean {
  return (
    version.billingInterval === "MONTHLY" ||
    version.billingInterval === "ANNUAL"
  )
}

/** Price in the smallest currency unit (cents for USD). */
export function priceInMinorUnits(version: PlanVersionForCheckout): number {
  return version.priceAmount ?? 0
}

/** Price as a decimal string with two places, for APIs that take it. */
export function priceAsDecimal(version: PlanVersionForCheckout): string {
  return ((version.priceAmount ?? 0) / 100).toFixed(2)
}
