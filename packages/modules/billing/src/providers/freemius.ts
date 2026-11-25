import { createHmac, timingSafeEqual } from "node:crypto"
import { Freemius } from "@freemius/sdk"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type {
  CheckoutArgs,
  CheckoutResult,
  PlanVersionForCheckout,
  ProviderCancelArgs,
  ProviderCancelOutcome,
  ProviderUpdateOutcome,
  VerifiedWebhook,
} from "./types"
import { fallbackEventId } from "./types"

const log = createLogger("billing:freemius")

// BIL-088: Freemius signs HMAC-SHA256 over the body only — no
// timestamp, nonce, or expiry — so a captured payload can be replayed
// indefinitely. The compensating check is first-seen time: the
// BillingEvent row the handler writes for the first delivery records
// when the event id was first seen. A redelivery of an ALREADY
// APPLIED event (processedAt set) older than this window is rejected
// outright; a redelivery inside the window is still deduped by
// `handleWebhook` (duplicate ack, never re-applied), and a delivery
// that was never applied (processedAt null, e.g. the first attempt
// crashed mid-apply) is always allowed through so it can still apply.
// Residual risk: an event id Freemius never sends (the Date.now()
// fallback) cannot be identified across deliveries, and a replay
// inside the window depends on the BillingEvent dedupe — see the
// handler's unique (provider, providerEventId) guard.
export const FREEMIUS_REPLAY_WINDOW_MS = 10 * 60 * 1000

// Freemius checkout. Freemius plans are created in the Freemius
// dashboard, not through the API, so the SendCMS plan version ->
// Freemius plan id mapping lives in the FREEMIUS_PLAN_MAP env var
// (JSON object: { "<planVersionId>": "<freemiusPlanId>" }). A version
// with no mapped Freemius plan cannot be sold through Freemius —
// the checkout refuses with a clear 422 instead of guessing.

function getPlanMap(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const raw = env.FREEMIUS_PLAN_MAP
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

// BIL-053: how many plan versions FREEMIUS_PLAN_MAP maps — the admin
// provider row surfaces this count, and enabling Freemius with zero
// mapped versions warns (the map is env JSON, not DB rows, so the
// service can only count it, not edit it).
export function getFreemiusPlanMapCount(
  env: NodeJS.ProcessEnv = process.env
): number {
  return Object.keys(getPlanMap(env)).length
}

// BIL-050: Freemius sandbox mode. Sandbox is ON whenever the
// Freemius config is not production-flagged — an explicit
// FREEMIUS_SANDBOX=true forces it on, "false" forces it off, and
// with no flag it defaults to sandbox outside production. The
// first live Freemius checkout must never also be the first test
// of the integration. Production enablement stays an explicit
// admin action (enabling the provider in the admin); this flag
// only decides whether checkouts created by SendCMS are test
// checkouts, so the path can be exercised with a test card / test
// PayPal before any production enablement.
export function isFreemiusSandbox(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = env.FREEMIUS_SANDBOX?.trim().toLowerCase()
  if (flag === "true") return true
  if (flag === "false") return false
  return env.NODE_ENV !== "production"
}

function freemiusPlanIdFor(versionId: string): string | null {
  const mapped = getPlanMap()[versionId]
  return typeof mapped === "string" && mapped.trim() ? mapped.trim() : null
}

function getClient(): Freemius {
  const productId = process.env.FREEMIUS_PRODUCT_ID
  const publicKey = process.env.FREEMIUS_PUBLIC_KEY
  const secretKey = process.env.FREEMIUS_SECRET_KEY
  const apiKey = process.env.FREEMIUS_API_KEY
  if (!productId || !publicKey || !secretKey || !apiKey) {
    throw new ApiError("Freemius is not configured", 422)
  }
  return new Freemius({ productId, publicKey, secretKey, apiKey })
}

// BIL-046: compare a SendCMS plan version against a Freemius
// plan's pricing, as reported by the Freemius pricing table.
// Returns a human-readable mismatch, or null when the two agree.
// `pricing` is null when the Freemius side could not be read —
// the caller logs a warning and proceeds (a failed price lookup
// must not block a checkout; the mismatch path is the hard stop).
export function checkFreemiusPlanPrice(
  version: {
    priceAmount: number | null
    priceCurrency: string
    billingInterval: string
  },
  pricing: {
    priceAmountMinor: number | null
    priceCurrency: string | null
    billingCycle: string | null
  } | null
): string | null {
  if (!pricing) return null
  const expectedCycle =
    version.billingInterval === "ANNUAL"
      ? "yearly"
      : version.billingInterval === "MONTHLY"
        ? "monthly"
        : version.billingInterval === "ONE_TIME"
          ? "oneoff"
          : null
  if (
    pricing.priceAmountMinor !== null &&
    (version.priceAmount ?? 0) !== pricing.priceAmountMinor
  ) {
    return `Freemius plan price (${pricing.priceAmountMinor}) does not match the SendCMS version price (${version.priceAmount ?? 0})`
  }
  if (
    pricing.priceCurrency !== null &&
    version.priceCurrency.toUpperCase() !== pricing.priceCurrency.toUpperCase()
  ) {
    return `Freemius plan currency (${pricing.priceCurrency}) does not match the SendCMS version currency (${version.priceCurrency})`
  }
  if (
    expectedCycle !== null &&
    pricing.billingCycle !== null &&
    pricing.billingCycle.toLowerCase() !== expectedCycle
  ) {
    return `Freemius plan billing cycle (${pricing.billingCycle}) does not match the SendCMS version interval (${version.billingInterval})`
  }
  return null
}

// Read one Freemius plan's pricing from the pricing table, in the
// shape the SDK returns it. Defensive: the table shape is
// OpenAPI-derived and the admin may not have the plan in it, so
// anything unexpected returns null (caller warns + proceeds).
async function readFreemiusPlanPricing(
  freemius: Freemius,
  freemiusPlanId: string
): Promise<{
  priceAmountMinor: number | null
  priceCurrency: string | null
  billingCycle: string | null
} | null> {
  try {
    const table = (await freemius.api.product.retrievePricingData()) as unknown
    const plans =
      table && typeof table === "object"
        ? ((table as Record<string, unknown>).plans as unknown)
        : null
    if (!Array.isArray(plans)) return null
    const plan = plans.find(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        String((p as Record<string, unknown>).id) === freemiusPlanId
    ) as Record<string, unknown> | undefined
    if (!plan) return null
    const pricing = Array.isArray(plan.pricing) ? plan.pricing[0] : null
    if (!pricing || typeof pricing !== "object") return null
    const row = pricing as Record<string, unknown>
    const amount =
      typeof row.amount === "number"
        ? row.amount
        : typeof row.price === "number"
          ? row.price
          : null
    return {
      priceAmountMinor: amount,
      priceCurrency: typeof row.currency === "string" ? row.currency : null,
      billingCycle:
        typeof row.billing_cycle === "string"
          ? row.billing_cycle
          : typeof row.cycle === "string"
            ? row.cycle
            : null,
    }
  } catch (err) {
    log.warn("Freemius pricing-table read failed; price cross-check skipped", {
      error: err instanceof Error ? err.message : String(err),
      freemiusPlanId,
    })
    return null
  }
}

export async function createFreemiusCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  const planId = freemiusPlanIdFor(args.version.id)
  if (!planId) {
    throw new ApiError(
      `No Freemius plan is mapped for this plan version. Map it in FREEMIUS_PLAN_MAP first.`,
      422
    )
  }
  const freemius = getClient()
  // BIL-046: cross-check the mapped Freemius plan's price /
  // currency / billing cycle against the SendCMS version before
  // selling it — a mis-mapped plan used to charge the wrong amount
  // while granting the SendCMS entitlements.
  const pricing = await readFreemiusPlanPricing(freemius, planId)
  const mismatch = checkFreemiusPlanPrice(args.version, pricing)
  if (mismatch) {
    log.warn("Freemius plan price mismatch; checkout refused", {
      planVersionId: args.version.id,
      freemiusPlanId: planId,
      mismatch,
    })
    throw new ApiError(
      `This plan cannot be sold through Freemius right now: ${mismatch}.`,
      422
    )
  }
  if (!pricing) {
    log.warn(
      "Freemius plan price could not be verified; checkout proceeding unverified",
      { planVersionId: args.version.id, freemiusPlanId: planId }
    )
  }
  const checkout = await freemius.checkout.create({
    user: { email: args.customer.email },
    planId,
    // BIL-050: sandbox checkouts in non-production (see
    // isFreemiusSandbox) so the path is exercisable without
    // charging a real customer.
    isSandbox: isFreemiusSandbox(),
  })
  // BIL-048: the service-built cancel URL is the checkout's cancel
  // button — a customer who abandons the hosted checkout gets a
  // SendCMS return path instead of only the browser back button.
  checkout.setCancelButton(args.cancelUrl)
  const url = checkout.getLink()
  if (!url) throw new ApiError("Freemius did not return a checkout URL", 502)
  return { checkoutUrl: url }
}

// BIL-001 / BIL-082: cancel at the provider. Freemius cancels the
// subscription attached to a LICENSE (the stored identity — see
// BIL-043) via a signed DELETE to cancel-current-subscription.
// Freemius has no cancel-at-period-end: a cancel is immediate and
// the outcome says so. A provider failure is a 502, never a silent
// local-only cancel.
export async function cancelFreemiusSubscription(
  args: ProviderCancelArgs
): Promise<ProviderCancelOutcome> {
  const freemius = getClient()
  const productId = process.env.FREEMIUS_PRODUCT_ID
  if (!productId) throw new ApiError("Freemius is not configured", 422)
  const path = `/products/${encodeURIComponent(productId)}/licenses/${encodeURIComponent(args.providerSubscriptionId)}/cancel-current-subscription.json`
  const url = freemius.api.createSignedUrl(path)
  let res: Response
  try {
    res = await fetch(url, { method: "DELETE" })
  } catch (error) {
    log.warn("Freemius subscription cancel failed", {
      licenseId: args.providerSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError(
      "The payment provider could not cancel the subscription. Please try again.",
      502
    )
  }
  if (!res.ok) {
    log.warn("Freemius subscription cancel failed", {
      licenseId: args.providerSubscriptionId,
      status: res.status,
    })
    throw new ApiError(
      "The payment provider could not cancel the subscription. Please try again.",
      502
    )
  }
  return {
    canceledAtProvider: true,
    immediate: true,
    note: args.cancelAtPeriodEnd
      ? "Freemius cancels immediately; cancel-at-period-end is not supported by Freemius."
      : undefined,
  }
}

// BIL-089: Freemius exposes no subscription plan-change API in the
// SDK — a migration cannot move the Freemius subscription to a new
// plan. The migration proceeds as an explicitly SendCMS-only change
// (the caller records billingUnchanged), never pretending the
// provider was updated.
export async function updateFreemiusSubscriptionPlan(
  providerSubscriptionId: string,
  version: PlanVersionForCheckout
): Promise<ProviderUpdateOutcome> {
  return {
    updated: false,
    reason:
      `Freemius has no subscription plan-change API, so license ${providerSubscriptionId} ` +
      `keeps billing the old plan (target version ${version.id} not applied at the provider).`,
  }
}

// Verify the Freemius webhook: HMAC-SHA256 of the raw body with the
// Product Secret Key, compared (timing-safe) against the x-signature
// header. Then translate the event. Activation comes from
// `license.created`: the license's plan_id maps back through
// FREEMIUS_PLAN_MAP to a SendCMS plan version, and the buyer's email
// is returned for the SERVICE to resolve (SRC-207 — provider
// adapters never import the DB or resolve users themselves).
// The replay check (BIL-088) lives in the billing service's
// handleWebhook, which already owns the BillingEvent row.
export async function verifyFreemiusWebhook(
  rawBody: string,
  signature: string | null
): Promise<VerifiedWebhook> {
  const secretKey = process.env.FREEMIUS_SECRET_KEY
  // BIL-101: 503, not 422 — a missing secret is a server-side
  // misconfiguration the provider must retry, not a permanent
  // failure.
  if (!secretKey) throw new ApiError("Freemius is not configured", 503)
  if (!signature) throw new ApiError("Missing Freemius signature", 401)
  const expected = createHmac("sha256", secretKey).update(rawBody).digest("hex")
  const given = Buffer.from(signature, "utf8")
  const want = Buffer.from(expected, "utf8")
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    log.warn("Freemius webhook signature verification failed")
    throw new ApiError("Invalid Freemius webhook signature", 401)
  }

  let event: {
    id?: string
    type?: string
    objects?: Record<string, unknown>
    data?: Record<string, unknown>
  }
  try {
    event = JSON.parse(rawBody) as {
      id?: string
      type?: string
      objects?: Record<string, unknown>
      data?: Record<string, unknown>
    }
  } catch {
    throw new ApiError("Invalid Freemius webhook body", 400)
  }
  const eventType = typeof event.type === "string" ? event.type : "unknown"
  // SRC-212: the fallback is a content hash, not Date.now() — two
  // distinct no-id deliveries in the same millisecond no longer
  // collide and drop each other as duplicates, while a redelivery
  // of the same payload dedupes to the same id.
  const eventId =
    typeof event.id === "string"
      ? event.id
      : fallbackEventId("freemius", eventType, rawBody)
  if (typeof event.id !== "string") {
    log.warn("Freemius webhook without an event id; using a content-hash id", {
      eventType,
    })
  }
  const ignored: VerifiedWebhook = {
    eventId,
    eventType,
    event: { kind: "ignored" },
  }
  const objects = event.objects ?? {}
  const data = event.data ?? {}
  const license =
    objects.license && typeof objects.license === "object"
      ? (objects.license as Record<string, unknown>)
      : null
  const user =
    objects.user && typeof objects.user === "object"
      ? (objects.user as Record<string, unknown>)
      : null
  // The license id is the stored identity for Freemius (BIL-043):
  // activation stores it as providerSubscriptionId, so every later
  // lookup resolves by it — never by the subscription id.
  const licenseId =
    typeof data.license_id === "string"
      ? data.license_id
      : license && typeof license.id === "string"
        ? license.id
        : null
  const freemiusPlanId =
    license && license.plan_id != null ? String(license.plan_id) : null

  if (eventType === "license.created" || eventType === "subscription.created") {
    const email = user && typeof user.email === "string" ? user.email : null
    if (!freemiusPlanId || !licenseId || !email) return ignored
    const planMap = getPlanMap()
    const planVersionId =
      Object.entries(planMap).find(
        ([, mappedId]) => String(mappedId) === freemiusPlanId
      )?.[0] ?? null
    if (!planVersionId) {
      log.warn("Freemius webhook for an unmapped plan", {
        freemiusPlanId,
        licenseId,
      })
      return ignored
    }
    // BIL-046: the license's own expiration is the period end —
    // the SendCMS interval is not a substitute for Freemius's.
    const expiration =
      typeof data.expiration === "string" ? data.expiration : null
    return {
      eventId,
      eventType,
      event: {
        kind: "freemius-checkout",
        planVersionId,
        providerSubscriptionId: licenseId,
        periodEnd: freemiusDate(expiration),
        buyerEmail: email,
        providerReference: licenseId,
      },
    }
  }

  if (eventType === "license.extended") {
    if (!licenseId) return ignored
    const to = typeof data.to === "string" ? data.to : null
    return {
      eventId,
      eventType,
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: licenseId,
        periodEnd: freemiusDate(to),
      },
    }
  }

  // BIL-045: terminal / failure events. A shortened license moves
  // the period end back; an expired license, a cancelled license,
  // a deleted license, and a last failed renewal all end access.
  if (eventType === "license.shortened") {
    if (!licenseId) return ignored
    const to = typeof data.to === "string" ? data.to : null
    return {
      eventId,
      eventType,
      event: {
        kind: "subscription-updated",
        providerSubscriptionId: licenseId,
        status: "shortened",
        periodEnd: freemiusDate(to),
      },
    }
  }

  if (
    eventType === "license.expired" ||
    eventType === "license.cancelled" ||
    eventType === "license.deleted"
  ) {
    if (!licenseId) return ignored
    return {
      eventId,
      eventType,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: licenseId,
      },
    }
  }

  if (
    eventType === "subscription.renewal.failed" ||
    eventType === "subscription.renewal.failed.last" ||
    eventType === "subscription.payment_failed"
  ) {
    if (!licenseId) return ignored
    return {
      eventId,
      eventType,
      event: {
        kind: "payment-failed",
        providerSubscriptionId: licenseId,
      },
    }
  }

  // BIL-043: prefer the LICENSE id — the stored identity — over
  // the subscription id. The two are different entities; the cancel
  // handler used to pick the subscription id and never match a row.
  if (eventType === "subscription.cancelled") {
    if (!licenseId) return ignored
    return {
      eventId,
      eventType,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: licenseId,
      },
    }
  }

  // BIL-045 / BIL-081: a plan change on the license moves the
  // subscription onto the newly mapped SendCMS version; a refund
  // or dispute cancels it (full refund — Freemius refund payloads
  // carry no partial amount to distinguish with).
  if (eventType === "license.plan.changed") {
    if (!licenseId) return ignored
    const toPlanId = data.to_plan_id != null ? String(data.to_plan_id) : null
    const planMap = getPlanMap()
    const planVersionId =
      toPlanId &&
      (Object.entries(planMap).find(
        ([, mappedId]) => String(mappedId) === toPlanId
      )?.[0] ??
        null)
    if (!planVersionId) {
      log.warn("Freemius license plan change to an unmapped plan", {
        licenseId,
        toPlanId,
      })
      return ignored
    }
    return {
      eventId,
      eventType,
      event: {
        kind: "subscription-updated",
        providerSubscriptionId: licenseId,
        status: "plan-changed",
        planVersionId,
      },
    }
  }

  if (
    eventType === "payment.refunded" ||
    eventType === "payment.dispute.created"
  ) {
    if (!licenseId) return ignored
    return {
      eventId,
      eventType,
      event: {
        kind: "payment-refunded",
        providerSubscriptionId: licenseId,
        providerReference: licenseId,
        fullRefund: true,
      },
    }
  }

  // BIL-045: unhandled types are visible, not silent — the license
  // id rides on the log line so an admin can trace the event.
  log.warn("Freemius webhook event type not handled", {
    eventType,
    licenseId,
  })
  return ignored
}

// Freemius dates arrive as "YYYY-MM-DD HH:mm:ss" — the space form
// does not parse as ISO, so it is normalised to "T" first. Null
// when absent or unparseable.
function freemiusDate(value: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value.replace(" ", "T"))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
