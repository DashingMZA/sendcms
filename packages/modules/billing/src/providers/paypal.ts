import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import { paypalMode } from "../registry"
import type {
  CheckoutArgs,
  CheckoutResult,
  ProviderCancelArgs,
  ProviderCancelOutcome,
  ProviderUpdateOutcome,
  VerifiedWebhook,
} from "./types"
import {
  BILLING_PROVIDER_TIMEOUT_MS,
  isRecurring,
  priceAsDecimal,
} from "./types"

const log = createLogger("billing:paypal")

// PayPal runs on direct REST calls: the official server SDK (v2.5)
// has no catalog controller, so products and billing plans cannot be
// created through it. Same endpoints the SDK would call, same shape.
// PAYPAL_MODE is sandbox by default — live only when the admin sets
// it to "live" with live credentials. Any other value is a
// misconfiguration: `paypalMode()` throws a 422 naming it (BIL-009)
// instead of silently running sandbox.

// BIL-009: log the effective mode once per process, so a sandbox
// deploy is visible in the logs instead of discovered at checkout.
let loggedPayPalMode = false

function baseUrl(): string {
  const mode = paypalMode()
  if (!loggedPayPalMode) {
    loggedPayPalMode = true
    log.info("PayPal mode", { mode })
  }
  return mode === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com"
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new ApiError("PayPal is not configured", 422)
  }
  return { clientId, clientSecret }
}

// BIL-019: a single retry for transient upstream failures (502/503/504
// — PayPal occasionally answers a verify call with a 502). The retry is
// opt-in per call: only the idempotent verify call retries, never a
// create that might double-issue a resource. A timed-out attempt is
// retried the same way (the verify call is a read).
export const PAYPAL_VERIFY_RETRY_DELAY_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type PayPalFetchOptions = {
  /** BIL-019: retry once on a transient 502/503/504 (or a timeout). */
  retryTransient?: boolean
}

async function paypalFetch(
  path: string,
  method: "GET" | "POST",
  accessToken: string | null,
  body?: unknown,
  // BIL-014: per-call idempotency key, sent as PayPal-Request-Id so a
  // retried checkout replays the same provider object instead of
  // creating a duplicate.
  requestId?: string,
  options: PayPalFetchOptions = {}
): Promise<unknown> {
  // SRC-233: bounded — a hung PayPal call used to hang the
  // checkout/webhook route indefinitely. `AbortSignal.timeout`
  // (the Turnstile/DoH precedent) aborts the fetch; the abort is
  // mapped to the same generic 502 as any other PayPal failure, so
  // no provider internals reach the customer.
  const maxAttempts = options.retryTransient ? 2 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(BILLING_PROVIDER_TIMEOUT_MS),
      })
    } catch (err) {
      // BIL-019: retry a timed-out verify attempt once (same idempotent
      // read); a timeout on the final attempt is the usual generic 502.
      if (
        options.retryTransient &&
        err instanceof Error &&
        err.name === "TimeoutError" &&
        attempt + 1 < maxAttempts
      ) {
        log.warn("PayPal request timed out; retrying once", {
          path,
          timeoutMs: BILLING_PROVIDER_TIMEOUT_MS,
        })
        await sleep(PAYPAL_VERIFY_RETRY_DELAY_MS)
        continue
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        log.warn("PayPal request timed out", {
          path,
          timeoutMs: BILLING_PROVIDER_TIMEOUT_MS,
        })
        throw new ApiError(
          "The payment provider is unavailable. Please try again.",
          502
        )
      }
      throw err
    }
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!res.ok) {
      // BIL-019: one retry on a transient upstream status, then the
      // usual generic 502 (no provider detail leaks to the caller).
      if (
        options.retryTransient &&
        (res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt + 1 < maxAttempts
      ) {
        log.warn("PayPal request got a transient status; retrying once", {
          path,
          status: res.status,
        })
        await sleep(PAYPAL_VERIFY_RETRY_DELAY_MS)
        continue
      }
      // BIL-024: the provider's raw error text is logged server-side
      // only — the customer gets a generic 502, never PayPal internals.
      const detail =
        (json?.message as string | undefined) ??
        (json?.error_description as string | undefined) ??
        `PayPal request failed (${res.status})`
      log.warn("PayPal request failed", { path, status: res.status, detail })
      throw new ApiError(
        "The payment provider is unavailable. Please try again.",
        502
      )
    }
    return json
  }
  // Unreachable: the loop always returns or throws.
  throw new ApiError(
    "The payment provider is unavailable. Please try again.",
    502
  )
}

// BIL-014: one request id per provider call, derived from the checkout
// attempt id so a retried checkout replays the same objects.
function attemptRequestId(args: CheckoutArgs, suffix: string): string {
  const attempt = args.idempotencyKey?.trim() || "no-attempt"
  return `${attempt}:${suffix}`
}

// BIL-022: PayPal access tokens are valid ~9 h, but every checkout and
// every webhook verification used to pay for a fresh OAuth exchange.
// Cache `{ token, expiresAt }` in module scope and reuse it until near
// expiry. The cache is keyed by client id, so a credential rotation
// never reuses a token minted for the old credentials. `expires_in`
// comes back in seconds; when it is missing (or unusable) fall back to
// the documented ~9 h lifetime. `resetPayPalTokenCache()` is the
// test/reset hook (the reset*Cache precedent in @sendcms/plans and
// @sendcms/security).
type CachedPayPalToken = {
  token: string
  expiresAt: number
  clientId: string
}

let cachedPayPalToken: CachedPayPalToken | null = null

const PAYPAL_TOKEN_SAFETY_MARGIN_MS = 60_000
const PAYPAL_TOKEN_DEFAULT_TTL_MS = 9 * 60 * 60 * 1000

export function resetPayPalTokenCache(): void {
  cachedPayPalToken = null
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret } = credentials()
  if (
    cachedPayPalToken &&
    cachedPayPalToken.clientId === clientId &&
    Date.now() < cachedPayPalToken.expiresAt
  ) {
    return cachedPayPalToken.token
  }
  // SRC-233: bounded, same as paypalFetch — the token call is the
  // first hop of every PayPal checkout/verification.
  let res: Response
  try {
    res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(BILLING_PROVIDER_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      log.warn("PayPal token request timed out", {
        timeoutMs: BILLING_PROVIDER_TIMEOUT_MS,
      })
      throw new ApiError("PayPal authentication failed", 502)
    }
    throw err
  }
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!res.ok || typeof json?.access_token !== "string") {
    throw new ApiError("PayPal authentication failed", 502)
  }
  // BIL-022: cache the token until shortly before it expires.
  const expiresInMs =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? json.expires_in * 1000
      : PAYPAL_TOKEN_DEFAULT_TTL_MS
  cachedPayPalToken = {
    token: json.access_token,
    expiresAt: Date.now() + expiresInMs - PAYPAL_TOKEN_SAFETY_MARGIN_MS,
    clientId,
  }
  return json.access_token
}

type PayPalLink = { rel: string; href: string }

function approveLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null
  const found = (links as PayPalLink[]).find((l) => l.rel === "approve")
  return found?.href ?? null
}

async function createProduct(
  accessToken: string,
  name: string,
  requestId: string
): Promise<string> {
  const created = (await paypalFetch(
    "/v1/catalogs/products",
    "POST",
    accessToken,
    {
      name,
      description: `${name} — SendCMS plan`,
      type: "SERVICE",
      category: "SOFTWARE",
    },
    requestId
  )) as { id?: string }
  if (!created.id) throw new ApiError("PayPal did not return a product id", 502)
  return created.id
}

async function createPlan(
  accessToken: string,
  productId: string,
  args: CheckoutArgs
): Promise<string> {
  const { version } = args
  const currency = version.priceCurrency.toUpperCase()
  const intervalUnit = version.billingInterval === "ANNUAL" ? "YEAR" : "MONTH"
  const regularCycle = {
    frequency: { interval_unit: intervalUnit, interval_count: 1 },
    tenure_type: "REGULAR",
    sequence: version.trialDays > 0 ? 2 : 1,
    total_cycles: 0,
    pricing_scheme: {
      fixed_price: { value: priceAsDecimal(version), currency_code: currency },
    },
  }
  const cycles =
    version.trialDays > 0
      ? [
          {
            frequency: {
              interval_unit: "DAY",
              interval_count: version.trialDays,
            },
            tenure_type: "TRIAL",
            sequence: 1,
            total_cycles: 1,
            pricing_scheme: {
              fixed_price: { value: "0", currency_code: currency },
            },
          },
          regularCycle,
        ]
      : [regularCycle]
  const created = (await paypalFetch(
    "/v1/billing/plans",
    "POST",
    accessToken,
    {
      product_id: productId,
      name: `${version.planName} plan`,
      status: "ACTIVE",
      billing_cycles: cycles,
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    },
    attemptRequestId(args, "plan")
  )) as { id?: string }
  if (!created.id) throw new ApiError("PayPal did not return a plan id", 502)
  return created.id
}

// PayPal checkout: a Product + billing Plan are created on the fly
// from the plan version (no stored mapping), then a subscription.
// `custom_id` carries userId:planVersionId so the webhook can
// activate the right subscription. One-time plans use Orders v2
// (CAPTURE) instead — same custom_id.
export async function createPayPalCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  const accessToken = await getAccessToken()
  const { version, customer } = args
  const customId = `${customer.userId}:${version.id}`
  const currency = version.priceCurrency.toUpperCase()
  // SRC-222: the catalog ids created by this checkout (only the
  // ones that were not cached yet) — the service persists them on
  // the plan version so the next checkout reuses them.
  const catalog: NonNullable<CheckoutResult["catalog"]> = {}

  if (!isRecurring(version)) {
    const order = (await paypalFetch(
      "/v2/checkout/orders",
      "POST",
      accessToken,
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: customId,
            description: `${version.planName} plan`,
            amount: {
              currency_code: currency,
              value: priceAsDecimal(version),
            },
          },
        ],
        application_context: {
          return_url: args.successUrl,
          cancel_url: args.cancelUrl,
          user_action: "PAY_NOW",
        },
      },
      attemptRequestId(args, "order")
    )) as { id?: string; links?: PayPalLink[] }
    const url = approveLink(order.links)
    if (!order.id || !url) {
      throw new ApiError("PayPal did not return a checkout URL", 502)
    }
    return { checkoutUrl: url, providerCheckoutId: order.id }
  }

  // SRC-222: reuse the cached product + plan for this plan version
  // when they exist — every checkout used to mint a new product and
  // billing plan, including abandoned ones.
  let productId = version.paypalProductId ?? null
  if (!productId) {
    productId = await createProduct(
      accessToken,
      `${version.planName} plan`,
      attemptRequestId(args, "product")
    )
    catalog.paypalProductId = productId
  }
  let planId = version.paypalPlanId ?? null
  if (!planId) {
    planId = await createPlan(accessToken, productId, args)
    catalog.paypalPlanId = planId
  }
  const subscription = (await paypalFetch(
    "/v1/billing/subscriptions",
    "POST",
    accessToken,
    {
      plan_id: planId,
      custom_id: customId,
      subscriber: { email_address: customer.email },
      application_context: {
        brand_name: "SendCMS",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: args.successUrl,
        cancel_url: args.cancelUrl,
      },
    },
    attemptRequestId(args, "subscription")
  )) as { id?: string; links?: PayPalLink[] }
  const url = approveLink(subscription.links)
  if (!subscription.id || !url) {
    throw new ApiError("PayPal did not return a checkout URL", 502)
  }
  return {
    checkoutUrl: url,
    providerCheckoutId: subscription.id,
    ...(Object.keys(catalog).length > 0 ? { catalog } : {}),
  }
}

// BIL-015 / BIL-016: read a PayPal subscription (or one-time order)
// back for the success-URL verification and the reconciliation
// path — the resource carries the payment state and the SendCMS
// custom_id, so a paid subscription whose webhook was lost can
// still be proven and activated.
export async function retrievePayPalSubscription(
  subscriptionId: string
): Promise<Record<string, unknown>> {
  const accessToken = await getAccessToken()
  const found = await paypalFetch(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    "GET",
    accessToken
  )
  if (!found || typeof found !== "object") {
    throw new ApiError("PayPal subscription not found", 502)
  }
  return found as Record<string, unknown>
}

export async function retrievePayPalOrder(
  orderId: string
): Promise<Record<string, unknown>> {
  const accessToken = await getAccessToken()
  const found = await paypalFetch(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    "GET",
    accessToken
  )
  if (!found || typeof found !== "object") {
    throw new ApiError("PayPal order not found", 502)
  }
  return found as Record<string, unknown>
}

// Verify the webhook with PayPal's verify-webhook-signature endpoint
// and translate the event. The caller passes the raw body string and
// the headers it received.
export async function verifyPayPalWebhook(
  rawBody: string,
  headers: Record<string, string>
): Promise<VerifiedWebhook> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  // BIL-101: 503, not 422 — a missing webhook id is a server-side
  // misconfiguration PayPal must retry, not a permanent failure.
  if (!webhookId) throw new ApiError("PayPal is not configured", 503)
  const authAlgo = headers["paypal-auth-algo"]
  const certUrl = headers["paypal-cert-url"]
  const transmissionId = headers["paypal-transmission-id"]
  const transmissionSig = headers["paypal-transmission-sig"]
  const transmissionTime = headers["paypal-transmission-time"]
  if (
    !authAlgo ||
    !certUrl ||
    !transmissionId ||
    !transmissionSig ||
    !transmissionTime
  ) {
    throw new ApiError("Missing PayPal webhook signature headers", 401)
  }
  let event: {
    id?: string
    event_type?: string
    resource?: Record<string, unknown>
  }
  try {
    event = JSON.parse(rawBody) as {
      id?: string
      event_type?: string
      resource?: Record<string, unknown>
    }
  } catch {
    throw new ApiError("Invalid PayPal webhook body", 400)
  }
  if (!event.id || !event.event_type) {
    throw new ApiError("Invalid PayPal webhook body", 400)
  }

  // BIL-101: missing PayPal credentials are the same retryable
  // misconfiguration as a missing webhook id — a 422 here would
  // make PayPal drop the event permanently.
  let accessToken: string
  try {
    accessToken = await getAccessToken()
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      throw new ApiError("PayPal is not configured", 503)
    }
    throw error
  }
  // BIL-019: the verify call is an idempotent read — retry it once on
  // a transient 502/503/504 (or a timeout) instead of dropping a
  // legitimate webhook on one bad upstream response.
  const verification = (await paypalFetch(
    "/v1/notifications/verify-webhook-signature",
    "POST",
    accessToken,
    {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    },
    undefined,
    { retryTransient: true }
  )) as { verification_status?: string }
  if (verification.verification_status !== "SUCCESS") {
    log.warn("PayPal webhook signature verification failed", {
      eventId: event.id,
    })
    throw new ApiError("Invalid PayPal webhook signature", 401)
  }

  const resource = event.resource ?? {}
  const ignored: VerifiedWebhook = {
    eventId: event.id,
    eventType: event.event_type,
    event: { kind: "ignored" },
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const customId =
      typeof resource.custom_id === "string" ? resource.custom_id : null
    const subscriptionId = typeof resource.id === "string" ? resource.id : null
    if (!customId || !subscriptionId) {
      // BIL-100: a PAID subscription with no custom_id is not
      // "ignored" — the customer paid and nothing can activate
      // them. Unmapped-payment: recorded, left unprocessed, and
      // visible in the admin reconciliation queue.
      if (subscriptionId) {
        return {
          eventId: event.id,
          eventType: event.event_type,
          event: {
            kind: "unmapped-payment",
            providerCheckoutId: subscriptionId,
            reason: "PayPal subscription has no SendCMS custom_id",
          },
        }
      }
      return ignored
    }
    const [userId, planVersionId] = customId.split(":")
    if (!userId || !planVersionId) {
      return {
        eventId: event.id,
        eventType: event.event_type,
        event: {
          kind: "unmapped-payment",
          providerCheckoutId: subscriptionId,
          reason: "PayPal custom_id has no userId/planVersionId",
        },
      }
    }
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "checkout-completed",
        userId,
        planVersionId,
        providerSubscriptionId: subscriptionId,
        periodEnd: null,
      },
    }
  }

  if (event.event_type === "PAYMENT.SALE.COMPLETED") {
    const agreementId =
      typeof resource.billing_agreement_id === "string"
        ? resource.billing_agreement_id
        : null
    if (!agreementId) return ignored
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: agreementId,
        periodEnd: null,
      },
    }
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const customId =
      typeof resource.custom_id === "string" ? resource.custom_id : null
    const orderId = typeof resource.id === "string" ? resource.id : null
    if (!customId || !orderId) {
      // BIL-100: a paid capture with no custom_id — same
      // unmapped-payment treatment as ACTIVATED above.
      if (orderId) {
        return {
          eventId: event.id,
          eventType: event.event_type,
          event: {
            kind: "unmapped-payment",
            providerCheckoutId: orderId,
            reason: "PayPal capture has no SendCMS custom_id",
          },
        }
      }
      return ignored
    }
    const [userId, planVersionId] = customId.split(":")
    if (!userId || !planVersionId) {
      return {
        eventId: event.id,
        eventType: event.event_type,
        event: {
          kind: "unmapped-payment",
          providerCheckoutId: orderId,
          reason: "PayPal custom_id has no userId/planVersionId",
        },
      }
    }
    // BIL-003: a one-time capture — the capture id is the
    // refund-matchable reference; the PayPal order id rides as
    // checkoutId when the payload carries it.
    const supplementary =
      resource.supplementary_data &&
      typeof resource.supplementary_data === "object"
        ? (resource.supplementary_data as Record<string, unknown>)
        : null
    const related =
      supplementary?.related_ids &&
      typeof supplementary.related_ids === "object"
        ? (supplementary.related_ids as Record<string, unknown>)
        : null
    const checkoutId =
      typeof related?.order_id === "string" ? related.order_id : null
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "checkout-completed",
        userId,
        planVersionId,
        providerSubscriptionId: orderId,
        periodEnd: null,
        isOneTime: true,
        providerReference: orderId,
        ...(checkoutId ? { checkoutId } : {}),
      },
    }
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
    // BIL-080: a failed renewal payment flips the subscription to
    // PAST_DUE (grace window) instead of being ignored.
    const subscriptionId = typeof resource.id === "string" ? resource.id : null
    if (!subscriptionId) return ignored
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "payment-failed",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.CANCELLED") {
    const subscriptionId = typeof resource.id === "string" ? resource.id : null
    if (!subscriptionId) return ignored
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  // BIL-006: the rest of the PayPal lifecycle. CREATED activates
  // from custom_id like ACTIVATED; UPDATED syncs status/period;
  // SUSPENDED is a payment failure (PAST_DUE grace); EXPIRED
  // cancels. `billing_info.next_billing_time` is the period end
  // when PayPal sends it.
  if (
    event.event_type === "BILLING.SUBSCRIPTION.CREATED" ||
    event.event_type === "BILLING.SUBSCRIPTION.UPDATED" ||
    event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
    event.event_type === "BILLING.SUBSCRIPTION.EXPIRED"
  ) {
    const subscriptionId = typeof resource.id === "string" ? resource.id : null
    if (!subscriptionId) return ignored
    if (event.event_type === "BILLING.SUBSCRIPTION.EXPIRED") {
      return {
        eventId: event.id,
        eventType: event.event_type,
        event: {
          kind: "subscription-canceled",
          providerSubscriptionId: subscriptionId,
        },
      }
    }
    if (event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED") {
      return {
        eventId: event.id,
        eventType: event.event_type,
        event: {
          kind: "payment-failed",
          providerSubscriptionId: subscriptionId,
        },
      }
    }
    if (event.event_type === "BILLING.SUBSCRIPTION.CREATED") {
      const customId =
        typeof resource.custom_id === "string" ? resource.custom_id : null
      if (customId) {
        const [userId, planVersionId] = customId.split(":")
        if (userId && planVersionId) {
          return {
            eventId: event.id,
            eventType: event.event_type,
            event: {
              kind: "checkout-completed",
              userId,
              planVersionId,
              providerSubscriptionId: subscriptionId,
              periodEnd: paypalPeriodEnd(resource),
            },
          }
        }
      }
    }
    const status =
      typeof resource.status === "string" ? resource.status.toLowerCase() : null
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "subscription-updated",
        providerSubscriptionId: subscriptionId,
        status,
        periodEnd: paypalPeriodEnd(resource),
      },
    }
  }

  // BIL-004 / BIL-081 (owner decision 2026-11-25): refunds.
  // PayPal's refund resource carries the refund amount but not the
  // original sale amount, so full vs partial cannot be told apart
  // from the payload — a PayPal refund is treated as FULL (cancel)
  // and the assumption is recorded in the audit detail. Stripe and
  // Polar carry exact amounts and distinguish properly.
  if (
    event.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
    event.event_type === "PAYMENT.SALE.REFUNDED"
  ) {
    const agreementId =
      typeof resource.billing_agreement_id === "string"
        ? resource.billing_agreement_id
        : null
    const saleId =
      typeof resource.sale_id === "string" ? resource.sale_id : null
    const amount =
      resource.amount && typeof resource.amount === "object"
        ? (resource.amount as Record<string, unknown>)
        : null
    const amountValue =
      typeof amount?.value === "string" ? Number(amount.value) : null
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "payment-refunded",
        providerSubscriptionId: agreementId,
        providerReference:
          saleId ?? (typeof resource.id === "string" ? resource.id : null),
        fullRefund: true,
        amountMinor:
          amountValue !== null && !Number.isNaN(amountValue)
            ? Math.round(amountValue * 100)
            : null,
      },
    }
  }

  return ignored
}

// `billing_info.next_billing_time` (ISO string) is PayPal's period
// end for a subscription resource; null when absent/unparseable.
function paypalPeriodEnd(resource: Record<string, unknown>): Date | null {
  const billingInfo =
    resource.billing_info && typeof resource.billing_info === "object"
      ? (resource.billing_info as Record<string, unknown>)
      : null
  const next =
    typeof billingInfo?.next_billing_time === "string"
      ? billingInfo.next_billing_time
      : null
  if (!next) return null
  const parsed = new Date(next)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// BIL-001 / BIL-082: cancel at the provider. PayPal has no
// cancel-at-period-end: a cancel is immediate, and the outcome says
// so — the caller mirrors it locally instead of recording a flag
// PayPal will never honour. A provider failure is a 502, never a
// silent local-only cancel.
export async function cancelPayPalSubscription(
  args: ProviderCancelArgs
): Promise<ProviderCancelOutcome> {
  const accessToken = await getAccessToken()
  await paypalFetch(
    `/v1/billing/subscriptions/${encodeURIComponent(args.providerSubscriptionId)}/cancel`,
    "POST",
    accessToken,
    { reason: args.reason ?? "Canceled by SendCMS" }
  )
  return {
    canceledAtProvider: true,
    immediate: true,
    note: args.cancelAtPeriodEnd
      ? "PayPal cancels immediately; cancel-at-period-end is not supported by PayPal."
      : undefined,
  }
}

// BIL-089: move a PayPal subscription onto a new plan version's
// billing plan (revise), so a migration changes what the customer
// is actually billed. A fresh product + plan are created from the
// target version, exactly as checkout does.
export async function updatePayPalSubscriptionPlan(
  providerSubscriptionId: string,
  args: CheckoutArgs
): Promise<ProviderUpdateOutcome> {
  const accessToken = await getAccessToken()
  const productId = await createProduct(
    accessToken,
    `${args.version.planName} plan`,
    attemptRequestId(args, "product")
  )
  const planId = await createPlan(accessToken, productId, args)
  await paypalFetch(
    `/v1/billing/subscriptions/${encodeURIComponent(providerSubscriptionId)}/revise`,
    "POST",
    accessToken,
    { plan_id: planId }
  )
  return { updated: true }
}
