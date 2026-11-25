import { createHash } from "node:crypto"
import type { BillingInterval } from "@sendcms/database"

// SRC-233 (another Wave 8 stream's change, restored here after a
// concurrent overwrite): the shared bound for provider calls —
// 30 s. Stripe takes it in ms, PayPal's AbortSignal.timeout in ms,
// Polar's client timeout in seconds (callers divide by 1000).
export const BILLING_PROVIDER_TIMEOUT_MS = 30_000

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
  // SRC-222: provider catalog objects cached per plan version, so a
  // checkout reuses the Stripe Price / PayPal product + plan / Polar
  // product instead of minting throwaway objects on every click.
  // Null/absent = not cached yet; the provider creates it once and
  // the service persists the id (see createCheckoutSession).
  stripePriceId?: string | null
  paypalProductId?: string | null
  paypalPlanId?: string | null
  polarProductId?: string | null
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
  // Per-checkout-attempt id (BIL-014): the service generates one per
  // attempt (or reuses the client's on retry) and each provider passes
  // a derived per-call key to its create calls, so a retried checkout
  // cannot create duplicate provider objects/sessions.
  idempotencyKey?: string
  // BIL-017: the Stripe Customer id for this user, when one already
  // exists — the provider passes `customer:` instead of minting a
  // new customer per checkout via `customer_email` alone.
  stripeCustomerId?: string | null
  // BIL-057: the customer's IP as seen by the checkout route
  // (first x-forwarded-for entry). Polar uses it for currency/tax
  // detection on server-side checkouts. A hint only — never trusted
  // for auth or geo-gating.
  customerIpAddress?: string | null
}

export type CheckoutResult = {
  checkoutUrl: string
  providerCheckoutId?: string
  // SRC-222: provider catalog ids created by this checkout (only
  // the ones that were not cached yet). The service persists them
  // on the plan version so the next checkout reuses them.
  catalog?: {
    stripePriceId?: string
    paypalProductId?: string
    paypalPlanId?: string
    polarProductId?: string
  }
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
      // BIL-003 / BIL-042: a one-time (non-recurring) purchase, not
      // a recurring subscription. The service records it as a
      // OneTimePurchase with a finite access window instead of a
      // perpetual subscription.
      isOneTime?: boolean
      // The refund-matchable payment reference (Stripe
      // payment_intent, PayPal capture id, Polar order id,
      // Freemius license id) — what a later refund event carries.
      providerReference?: string
      // The checkout session / order id the purchase came from.
      checkoutId?: string
      // BIL-049 / BIL-096: the trial end the provider reports for
      // this checkout (Polar subscription trial_end, Stripe
      // subscription trial_end when expanded). When present the
      // activation creates a TRIALING subscription ending then;
      // when absent the activation falls back to the version's
      // trialDays. Never set for non-trial checkouts.
      trialEnd?: Date | null
    }
  // SRC-207: Freemius resolves the buyer by email, and the buyer
  // lookup belongs in the service (only services import the DB),
  // not in the provider adapter. The adapter returns the buyer
  // email; the service resolves it (lower-cased) to a user and
  // activates, or throws 422 for an unresolvable buyer so the
  // event stays visible as unprocessed instead of silently
  // ignored.
  | {
      kind: "freemius-checkout"
      planVersionId: string
      providerSubscriptionId: string
      periodEnd: Date | null
      buyerEmail: string
      isOneTime?: boolean
      providerReference?: string
      checkoutId?: string
    }
  | {
      kind: "payment-succeeded"
      providerSubscriptionId: string
      periodEnd: Date | null
    }
  // BIL-080: a renewal payment failed — the service flips the
  // subscription to PAST_DUE (grace window) instead of ignoring it.
  | { kind: "payment-failed"; providerSubscriptionId: string }
  | { kind: "subscription-canceled"; providerSubscriptionId: string }
  // BIL-005 / BIL-006 / BIL-045 / BIL-047: a provider-side change
  // that is neither a cancel nor a payment failure — a plan/period
  // sync, a suspension, or a status transition. `status` is the
  // provider's raw status string, lower-cased; the service maps it.
  | {
      kind: "subscription-updated"
      providerSubscriptionId: string
      status?: string | null
      periodEnd?: Date | null
      cancelAtPeriodEnd?: boolean | null
      // BIL-045 (Freemius license.plan.changed): the subscription
      // moves onto this SendCMS plan version.
      planVersionId?: string | null
    }
  // BIL-081 / BIL-004 / BIL-047 (owner decision 2026-11-25): a
  // refund or chargeback. A FULL refund cancels the matching
  // subscription (downgrade to Free + audit); a PARTIAL refund
  // keeps it and surfaces in the admin subscription timeline.
  // `providerSubscriptionId` is null when the provider event
  // carries no subscription id (e.g. a Stripe charge refund) —
  // the service then resolves via `providerReference` against
  // one-time purchases.
  | {
      kind: "payment-refunded"
      providerSubscriptionId: string | null
      providerReference?: string | null
      fullRefund: boolean
      amountMinor?: number | null
    }
  // BIL-100 / BIL-026 / BIL-016: a PAID event that cannot be applied
  // automatically — the buyer/plan cannot be resolved (missing
  // SendCMS metadata), or the renewal carries no usable period
  // (an invoice with no line for the subscription). This is NOT
  // "ignored": the service records the event and leaves it
  // UNPROCESSED so it surfaces in the admin unprocessed-events
  // list (the reconciliation queue) instead of being acked and
  // forgotten. `providerCheckoutId` is the checkout/order id a
  // human can reconcile against; `providerSubscriptionId` is set
  // when the renewal's subscription is known.
  | {
      kind: "unmapped-payment"
      providerCheckoutId?: string | null
      providerSubscriptionId?: string | null
      reason: string
    }
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

// ─── Currency handling (BIL-011 / BIL-056) ────────────────────────────
//
// `priceAmount` is stored in HUNDREDTHS of the major unit for EVERY
// currency — the codebase's cents convention (a $10 plan stores
// 1000; a ¥1,000 plan stores 100000). Providers disagree about what
// they want: Stripe's `unit_amount` and Polar's `price_amount` are
// in the currency's SMALLEST unit (whole yen for JPY — no minor
// unit exists), and PayPal's `fixed_price.value` is a decimal
// string with NO decimals for zero-decimal currencies. The helpers
// below convert from the stored convention to what each provider
// expects, per currency exponent. A plan priced in a zero-decimal
// currency MUST store a multiple of 100 (a whole number of yen) —
// enforced by validatePriceForCheckout — so the division is exact
// and never silently rounds a price down.

// Stripe's zero-decimal currency list
// (https://docs.stripe.com/currencies#zero-decimal): these have no
// minor unit, so the smallest unit IS the major unit.
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/** 10^exponent minor units per major unit: 0 for zero-decimal, 2 otherwise. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2
}

/** True when the currency code is a well-formed ISO 4217 alpha-3 code. */
export function isValidCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency.trim().toUpperCase())
}

/** Price in the currency's smallest unit, for Stripe / Polar. */
export function priceInMinorUnits(version: PlanVersionForCheckout): number {
  const amount = version.priceAmount ?? 0
  if (currencyExponent(version.priceCurrency) === 0) {
    // Stored in hundredths; a zero-decimal currency has no minor
    // unit, so the provider amount is the whole-unit amount.
    return Math.round(amount / 100)
  }
  return amount
}

/** Price as a decimal string, for APIs that take it (PayPal). */
export function priceAsDecimal(version: PlanVersionForCheckout): string {
  const amount = version.priceAmount ?? 0
  if (currencyExponent(version.priceCurrency) === 0) {
    // PayPal rejects "1000.00" for JPY — the value must have no
    // decimals at all.
    return String(Math.round(amount / 100))
  }
  return (amount / 100).toFixed(2)
}

// ─── Polar currency validation (BIL-056) ─────────────────────────────
//
// Polar's `PresentmentCurrency` union
// (@polar-sh/sdk@1.3.2, dist/models-CkGCxGqD.d.cts:227) — the cast
// in createPolarCheckoutSession used to accept any 3-letter string
// and fail only at the Polar API call (generic 500). Validate here
// so an unsupported code is a clear 422 at checkout time.
export const POLAR_PRESENTMENT_CURRENCIES: ReadonlySet<string> = new Set([
  "AED",
  "ALL",
  "AMD",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BWP",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JMD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KRW",
  "KYD",
  "KZT",
  "LAK",
  "LKR",
  "LRD",
  "LSL",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MNT",
  "MOP",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SEK",
  "SGD",
  "SHP",
  "SOS",
  "SRD",
  "SZL",
  "THB",
  "TJS",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XOF",
  "XPF",
  "YER",
  "ZAR",
  "ZMW",
])

export function isPolarCurrencySupported(currency: string): boolean {
  return POLAR_PRESENTMENT_CURRENCIES.has(currency.trim().toUpperCase())
}

// ─── Provider-minimum price validation (BIL-027) ─────────────────────
//
// Stripe's published per-currency minimums, in STORED units
// (hundredths of the major unit — see the currency section above).
// A plan below the minimum passes every SendCMS check today and
// then fails inside the provider call as a generic 502; validate
// here so checkout refuses with a 422 naming the minimum instead.
// Currencies not listed fall back to 50 stored units ($0.50
// equivalent) — the conservative default, never a silent pass.
export const PROVIDER_MINIMUM_STORED_UNITS: Readonly<Record<string, number>> = {
  USD: 50,
  EUR: 50,
  GBP: 30,
  CAD: 50,
  AUD: 50,
  CHF: 50,
  NZD: 50,
  SGD: 50,
  HKD: 50,
  SEK: 50,
  NOK: 50,
  DKK: 50,
  PLN: 50,
  CZK: 50,
  HUF: 50,
  INR: 50,
  BRL: 50,
  MXN: 50,
  // Zero-decimal minimums, in stored (hundredths) units:
  // ¥50 = 5000, ₩500 = 50000.
  JPY: 5000,
  KRW: 50000,
}

export function providerMinimumStoredUnits(currency: string): number {
  return PROVIDER_MINIMUM_STORED_UNITS[currency.trim().toUpperCase()] ?? 50
}

/**
 * The price problem, if any, with selling this version through a
 * provider — null when the price is sellable. Checked by the billing
 * service at checkout time (BIL-027): a sub-minimum or malformed
 * price is a clear 422 naming the problem, never a generic 502
 * from inside the provider call. Free versions (null/<=0) are the
 * caller's concern (the free-plan refusal) and pass here.
 */
export function validatePriceForCheckout(
  version: PlanVersionForCheckout
): string | null {
  const currency = version.priceCurrency.trim().toUpperCase()
  if (!isValidCurrencyCode(version.priceCurrency)) {
    return `Invalid price currency "${version.priceCurrency}": expected a 3-letter ISO currency code (e.g. USD).`
  }
  const amount = version.priceAmount ?? 0
  if (amount <= 0) return null
  if (currencyExponent(currency) === 0 && amount % 100 !== 0) {
    return (
      `Price for ${currency} must be a whole number of ${currency} ` +
      `(stored in hundredths, so a multiple of 100) — ${amount} is not.`
    )
  }
  const minimum = providerMinimumStoredUnits(currency)
  if (amount < minimum) {
    const minimumMajor = (minimum / 100).toFixed(
      currencyExponent(currency) === 0 ? 0 : 2
    )
    return (
      `Price is below the provider minimum for ${currency} ` +
      `(minimum ${minimumMajor} ${currency}).`
    )
  }
  return null
}

// ─── BillingEvent.kind mapping (DB-015) ──────────────────────────────
//
// The normalized kind each webhook event maps to in the DB
// (`BillingEventKind` enum). The raw provider event type stays in
// `eventType` (open-ended per provider); `kind` is the closed,
// queryable set the handler switches over.
export type BillingEventKind =
  | "CHECKOUT_COMPLETED"
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_FAILED"
  | "SUBSCRIPTION_CANCELED"
  | "SUBSCRIPTION_UPDATED"
  | "PAYMENT_REFUNDED"
  | "UNMAPPED_PAYMENT"
  | "IGNORED"

export function billingEventKindFor(
  event: NormalizedBillingEvent
): BillingEventKind {
  switch (event.kind) {
    case "checkout-completed":
    case "freemius-checkout":
      return "CHECKOUT_COMPLETED"
    case "payment-succeeded":
      return "PAYMENT_SUCCEEDED"
    case "payment-failed":
      return "PAYMENT_FAILED"
    case "subscription-canceled":
      return "SUBSCRIPTION_CANCELED"
    case "subscription-updated":
      return "SUBSCRIPTION_UPDATED"
    case "payment-refunded":
      return "PAYMENT_REFUNDED"
    case "unmapped-payment":
      return "UNMAPPED_PAYMENT"
    case "ignored":
      return "IGNORED"
  }
}

// SRC-212: the stable fallback event id for a webhook delivery
// that carries no provider event id. A content hash, not
// `Date.now()`: two distinct deliveries in the same millisecond no
// longer collide and drop each other as duplicates, while a
// redelivery of the SAME payload dedupes to the same id (correct —
// it is the same event). The provider + type prefix keeps ids
// distinct across providers that happen to deliver identical
// bodies.
export function fallbackEventId(
  provider: string,
  eventType: string,
  rawBody: string
): string {
  const hash = createHash("sha256")
    .update(`${provider}:${eventType}:${rawBody}`)
    .digest("hex")
    .slice(0, 32)
  return `${provider}:${eventType}:${hash}`
}

// ─── Provider-side subscription operations (BIL-001 / BIL-082) ──────

// What a provider cancel returns. Some providers cannot schedule a
// cancel at period end (PayPal, Freemius cancel immediately) —
// `immediate` says what the provider actually did, so the caller
// can mirror it locally instead of recording a flag the provider
// will never honour. `canceledAtProvider` is false only when the
// provider reports the subscription was already canceled.
export type ProviderCancelOutcome = {
  canceledAtProvider: boolean
  immediate: boolean
  note?: string
}

export type ProviderCancelArgs = {
  providerSubscriptionId: string
  cancelAtPeriodEnd: boolean
  reason?: string | null
}

// What a provider plan-change (migration, BIL-089) returns.
// `updated` is false — with a reason — when the provider has no
// subscription-update API (Freemius, Gumroad) or the subscription
// is not provider-billed; the migration then proceeds as an
// explicitly SendCMS-only change, recorded as such.
export type ProviderUpdateOutcome = {
  updated: boolean
  reason?: string
}
