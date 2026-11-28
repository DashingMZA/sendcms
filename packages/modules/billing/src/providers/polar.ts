import { createPolar, webhooks, type models } from "@polar-sh/sdk/2026-10"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import { polarEnvironment } from "../registry"
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
  fallbackEventId,
  isPolarCurrencySupported,
  isRecurring,
  priceInMinorUnits,
} from "./types"

const log = createLogger("billing:polar")

// Polar checkout. The product is created on the fly from the plan
// version (no stored mapping) and a hosted checkout session is
// opened for it. POLAR_ENVIRONMENT is sandbox by default — live only
// when the admin sets it to "production" with a production token.
// Any other value is a misconfiguration: `polarEnvironment()` throws
// a 422 naming it (BIL-054) instead of silently running sandbox.
// The billing interval and the trial sit on the Polar product
// (recurring_interval / trial_interval), not on the price.

function getClient() {
  const accessToken = process.env.POLAR_ACCESS_TOKEN
  if (!accessToken) throw new ApiError("Polar is not configured", 422)
  const environment = polarEnvironment()
  // SRC-233: explicit timeout — the SDK default used to run
  // unconfigured. Polar's `timeout` is in SECONDS (unlike Stripe's
  // milliseconds).
  return createPolar({
    accessToken,
    environment,
    timeout: BILLING_PROVIDER_TIMEOUT_MS / 1000,
  })
}

// BIL-054: a production token against the sandbox host (or vice
// versa) fails auth at the first real call — surface it as a clear
// 502 naming the likely token/environment mismatch instead of a
// generic 500. The SDK error shape is not pinned (status when the
// SDK carries one, else the message), so both are checked.
function isPolarAuthError(error: unknown): boolean {
  const status =
    (error as { status?: unknown; statusCode?: unknown })?.status ??
    (error as { statusCode?: unknown })?.statusCode
  if (status === 401 || status === 403) return true
  const message = error instanceof Error ? error.message : String(error)
  return /unauthori[sz]ed|invalid[^a-z]*token|authentication/i.test(message)
}

function mapPolarError(
  error: unknown,
  fallbackMessage = "The payment provider is unavailable. Please try again.",
  fields: Record<string, unknown> = {}
): ApiError {
  log.warn("Polar request failed", {
    error: error instanceof Error ? error.message : String(error),
    ...fields,
  })
  if (isPolarAuthError(error)) {
    return new ApiError(
      "Polar rejected the access token — check that POLAR_ACCESS_TOKEN matches POLAR_ENVIRONMENT (sandbox and production tokens are separate).",
      502
    )
  }
  return new ApiError(fallbackMessage, 502)
}

export async function createPolarCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  const polar = getClient()
  const { version, customer } = args
  // BIL-056: the currency is validated against Polar's
  // PresentmentCurrency set here — the old unchecked cast let an
  // unsupported code (e.g. XXX) through to the Polar API call,
  // surfacing as a generic 500. Now it is a clear 422.
  if (!isPolarCurrencySupported(version.priceCurrency)) {
    throw new ApiError(
      `Currency ${version.priceCurrency.toUpperCase()} is not supported by Polar.`,
      422
    )
  }
  const currency =
    version.priceCurrency.toLowerCase() as models.PresentmentCurrency
  const recurring = isRecurring(version)
  const interval: models.RecurringInterval =
    version.billingInterval === "ANNUAL" ? "year" : "month"

  // SRC-222: reuse the cached product for this plan version when
  // one exists — every checkout used to mint a new product,
  // including abandoned ones. A fresh product is created once and
  // its id is returned (catalog) for the service to persist.
  let productId = version.polarProductId ?? null
  const catalog: NonNullable<CheckoutResult["catalog"]> = {}
  try {
    if (!productId) {
      const product = await polar.products.create(
        recurring
          ? {
              name: `${version.planName} plan`,
              recurring_interval: interval,
              recurring_interval_count: 1,
              ...(version.trialDays > 0
                ? {
                    trial_interval: "day" as models.TrialInterval,
                    trial_interval_count: version.trialDays,
                  }
                : {}),
              prices: [
                {
                  amount_type: "fixed",
                  price_amount: priceInMinorUnits(version),
                  price_currency: currency,
                },
              ],
            }
          : {
              name: `${version.planName} plan`,
              prices: [
                {
                  amount_type: "fixed",
                  price_amount: priceInMinorUnits(version),
                  price_currency: currency,
                },
              ],
            }
      )
      productId = product.id
      catalog.polarProductId = product.id
    }

    const checkout = await polar.checkouts.create({
      products: [productId],
      customer_email: customer.email,
      external_customer_id: customer.userId,
      success_url: args.successUrl,
      // BIL-048: the service-built cancel URL is the checkout's
      // return URL — a customer who abandons the hosted checkout
      // gets a SendCMS return path instead of only the browser
      // back button.
      return_url: args.cancelUrl,
      // BIL-057: the customer's IP helps Polar's currency/tax
      // detection on server-side checkouts (Polar cannot see it
      // otherwise). Omitted when the route could not determine it.
      ...(args.customerIpAddress
        ? { customer_ip_address: args.customerIpAddress }
        : {}),
      metadata: { user_id: customer.userId, plan_version_id: version.id },
    })
    if (!checkout.url) {
      throw new ApiError("Polar did not return a checkout URL", 502)
    }
    return {
      checkoutUrl: checkout.url,
      providerCheckoutId: checkout.id,
      ...(Object.keys(catalog).length > 0 ? { catalog } : {}),
    }
  } catch (error) {
    // BIL-054: an SDK failure is a 502 naming the likely
    // token/environment mismatch when it looks like auth; a
    // deliberate ApiError (e.g. no checkout URL) passes through.
    if (error instanceof ApiError) throw error
    throw mapPolarError(error)
  }
}

// BIL-001 / BIL-082: cancel at the provider. Immediate = revoke;
// at-period-end = update cancel_at_period_end (Polar supports it
// natively). A provider failure is a 502, never a silent local-only
// cancel.
export async function cancelPolarSubscription(
  args: ProviderCancelArgs
): Promise<ProviderCancelOutcome> {
  const polar = getClient()
  try {
    if (args.cancelAtPeriodEnd) {
      await polar.subscriptions.update(args.providerSubscriptionId, {
        cancel_at_period_end: true,
      })
      return { canceledAtProvider: true, immediate: false }
    }
    await polar.subscriptions.revoke(args.providerSubscriptionId)
    return { canceledAtProvider: true, immediate: true }
  } catch (error) {
    // BIL-054: map through the shared mapper so an auth failure
    // names the likely token/environment mismatch.
    throw mapPolarError(
      error,
      "The payment provider could not cancel the subscription. Please try again.",
      {
        subscriptionId: args.providerSubscriptionId,
      }
    )
  }
}

// BIL-089: move a Polar subscription onto a new plan version's
// product (with proration), so a migration changes what the
// customer is actually billed. A fresh product is created from the
// target version, exactly as checkout does, then the subscription
// is updated onto it.
export async function updatePolarSubscriptionPlan(
  providerSubscriptionId: string,
  args: CheckoutArgs
): Promise<ProviderUpdateOutcome> {
  const polar = getClient()
  const { version } = args
  const currency =
    version.priceCurrency.toLowerCase() as models.PresentmentCurrency
  const recurring = isRecurring(version)
  const interval: models.RecurringInterval =
    version.billingInterval === "ANNUAL" ? "year" : "month"
  try {
    const product = await polar.products.create(
      recurring
        ? {
            name: `${version.planName} plan`,
            recurring_interval: interval,
            recurring_interval_count: 1,
            prices: [
              {
                amount_type: "fixed",
                price_amount: priceInMinorUnits(version),
                price_currency: currency,
              },
            ],
          }
        : {
            name: `${version.planName} plan`,
            prices: [
              {
                amount_type: "fixed",
                price_amount: priceInMinorUnits(version),
                price_currency: currency,
              },
            ],
          }
    )
    await polar.subscriptions.update(providerSubscriptionId, {
      product_id: product.id,
      proration_behavior: "invoice",
    })
    return { updated: true }
  } catch (error) {
    // BIL-054: map through the shared mapper so an auth failure
    // names the likely token/environment mismatch.
    throw mapPolarError(
      error,
      "The payment provider could not change the subscription plan. Please try again.",
      {
        subscriptionId: providerSubscriptionId,
      }
    )
  }
}
//
// BIL-040: `webhooks.validateEvent` is ASYNC (SDK 1.3.2 returns
// `Promise<WebhookPayload>` — WebCrypto). This function is async and
// awaits it; the old sync call + `as unknown as` cast silently turned
// every payload into `undefined` fields (all webhooks ignored) and let
// a bad signature float as an unhandled rejection.
// BIL-041: Polar payloads carry NO top-level `id` — the stable event
// id lives only in the `webhook-id` header (Standard Webhooks), so
// that header is the event id. The `Date.now()` fallback fires only
// for malformed deliveries (no header, no payload id) and is logged.
export async function verifyPolarWebhook(
  rawBody: string,
  headers: Record<string, string>
): Promise<VerifiedWebhook> {
  const secret = process.env.POLAR_WEBHOOK_SECRET
  // BIL-101: 503, not 422 — a missing webhook secret is a
  // server-side misconfiguration Polar must retry, not a
  // permanent failure.
  if (!secret) throw new ApiError("Polar is not configured", 503)
  let payload: Awaited<ReturnType<typeof webhooks.validateEvent>>
  try {
    payload = await webhooks.validateEvent(rawBody, headers, secret)
  } catch (error) {
    log.warn("Polar webhook signature verification failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError("Invalid Polar webhook signature", 401)
  }
  const headerId = headers["webhook-id"]?.trim() || null
  const payloadId =
    "id" in payload && typeof payload.id === "string" ? payload.id : null
  // SRC-212: the fallback is a content hash, not Date.now() — two
  // distinct no-id deliveries in the same millisecond no longer
  // collide and drop each other as duplicates, while a redelivery
  // of the same payload dedupes to the same id.
  const eventId =
    headerId ?? payloadId ?? fallbackEventId("polar", payload.type, rawBody)
  if (!headerId && !payloadId) {
    log.warn(
      "Polar webhook without a webhook-id header; event id is a content hash",
      {
        eventType: payload.type,
      }
    )
  }
  const ignored: VerifiedWebhook = {
    eventId,
    eventType: payload.type,
    event: { kind: "ignored" },
  }
  // The SDK types `data` per event type; the translator below reads
  // it generically (every access guards with typeof), so narrow the
  // union to a record here.
  const data = (payload.data ?? {}) as unknown as Record<string, unknown>

  if (payload.type === "checkout.updated") {
    const status = typeof data.status === "string" ? data.status : null
    const subscriptionId =
      typeof data.subscription_id === "string" ? data.subscription_id : null
    const metadata =
      data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, unknown>)
        : null
    const userId =
      metadata && typeof metadata.user_id === "string" ? metadata.user_id : null
    const planVersionId =
      metadata && typeof metadata.plan_version_id === "string"
        ? metadata.plan_version_id
        : null
    if (
      (status === "confirmed" || status === "succeeded") &&
      subscriptionId &&
      userId &&
      planVersionId
    ) {
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "checkout-completed",
          userId,
          planVersionId,
          providerSubscriptionId: subscriptionId,
          periodEnd: null,
        },
      }
    }
    // BIL-042 (owner decision 2026-11-25): GRANT via order id. A
    // one-time checkout completes WITHOUT a subscription
    // (subscription_id is null) — the paid order still grants the
    // plan, as a one-time purchase with a finite access window.
    // The order id is the refund-matchable reference.
    if (
      (status === "confirmed" || status === "succeeded") &&
      !subscriptionId &&
      userId &&
      planVersionId
    ) {
      const orderId =
        typeof data.order_id === "string"
          ? data.order_id
          : typeof data.id === "string"
            ? data.id
            : null
      if (!orderId) return ignored
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "checkout-completed",
          userId,
          planVersionId,
          providerSubscriptionId: orderId,
          periodEnd: null,
          isOneTime: true,
          providerReference: orderId,
          checkoutId: typeof data.id === "string" ? data.id : orderId,
        },
      }
    }
    if (status === "confirmed" || status === "succeeded") {
      // BIL-100: a PAID checkout that cannot be resolved (a
      // subscription id with no metadata, or no metadata at all)
      // is not "ignored" — the customer paid and nothing can
      // activate them. Unmapped-payment: recorded, left
      // unprocessed, visible in the admin reconciliation queue.
      const checkoutId = typeof data.id === "string" ? data.id : null
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "unmapped-payment",
          providerCheckoutId: checkoutId,
          reason: "Polar checkout has no subscription id or SendCMS metadata",
        },
      }
    }
    return ignored
  }

  if (payload.type === "order.paid") {
    const subscriptionId =
      typeof data.subscription_id === "string" ? data.subscription_id : null
    if (subscriptionId) {
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "payment-succeeded",
          providerSubscriptionId: subscriptionId,
          periodEnd: null,
        },
      }
    }
    // BIL-042: a one-time order paid — no subscription id, but the
    // order carries the checkout metadata, so it grants like a
    // one-time checkout.updated.
    const metadata =
      data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, unknown>)
        : null
    const userId =
      metadata && typeof metadata.user_id === "string" ? metadata.user_id : null
    const planVersionId =
      metadata && typeof metadata.plan_version_id === "string"
        ? metadata.plan_version_id
        : null
    const orderId = typeof data.id === "string" ? data.id : null
    if (!userId || !planVersionId || !orderId) return ignored
    return {
      eventId,
      eventType: payload.type,
      event: {
        kind: "checkout-completed",
        userId,
        planVersionId,
        providerSubscriptionId: orderId,
        periodEnd: null,
        isOneTime: true,
        providerReference: orderId,
        checkoutId:
          typeof data.checkout_id === "string" ? data.checkout_id : orderId,
      },
    }
  }

  // BIL-047 / BIL-081 (owner decision 2026-11-25): refunds. The
  // payload carries the order's total and the refunded amount when
  // present; full vs partial is decided from them, defaulting to
  // FULL when the amounts are absent (a refund with no amount data
  // is treated as a full clawback, never silently kept).
  if (payload.type === "order.refunded") {
    const orderId =
      typeof data.order_id === "string"
        ? data.order_id
        : typeof data.id === "string"
          ? data.id
          : null
    const subscriptionId =
      typeof data.subscription_id === "string" ? data.subscription_id : null
    const total =
      typeof data.total_amount === "number" ? data.total_amount : null
    const refunded =
      typeof data.refunded_amount === "number"
        ? data.refunded_amount
        : typeof data.amount === "number"
          ? data.amount
          : null
    return {
      eventId,
      eventType: payload.type,
      event: {
        kind: "payment-refunded",
        providerSubscriptionId: subscriptionId,
        providerReference: orderId,
        fullRefund:
          total !== null && refunded !== null ? refunded >= total : true,
        amountMinor: refunded,
      },
    }
  }

  // BIL-047: a past-due subscription is a payment failure, not an
  // ignore — the service flips the subscription to PAST_DUE with a
  // grace window. (subscription.updated with status past_due is
  // handled the same way below.)
  if (payload.type === "subscription.past_due") {
    const subscriptionId = typeof data.id === "string" ? data.id : null
    if (!subscriptionId) return ignored
    return {
      eventId,
      eventType: payload.type,
      event: {
        kind: "payment-failed",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  // BIL-080: a past-due subscription update is a payment failure,
  // not an ignore — the service flips the subscription to PAST_DUE
  // with a grace window. Any other update syncs status / period /
  // cancel-at-period-end instead of being ignored.
  if (payload.type === "subscription.updated") {
    const status = typeof data.status === "string" ? data.status : null
    const subscriptionId = typeof data.id === "string" ? data.id : null
    if (!subscriptionId) return ignored
    if (status === "past_due") {
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "payment-failed",
          providerSubscriptionId: subscriptionId,
        },
      }
    }
    if (status === "canceled" || status === "revoked") {
      return {
        eventId,
        eventType: payload.type,
        event: {
          kind: "subscription-canceled",
          providerSubscriptionId: subscriptionId,
        },
      }
    }
    const periodEndRaw =
      typeof data.current_period_end === "string"
        ? data.current_period_end
        : null
    const periodEnd = periodEndRaw ? new Date(periodEndRaw) : null
    return {
      eventId,
      eventType: payload.type,
      event: {
        kind: "subscription-updated",
        providerSubscriptionId: subscriptionId,
        status,
        periodEnd:
          periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
        cancelAtPeriodEnd:
          typeof data.cancel_at_period_end === "boolean"
            ? data.cancel_at_period_end
            : null,
      },
    }
  }

  if (
    payload.type === "subscription.canceled" ||
    payload.type === "subscription.revoked"
  ) {
    const subscriptionId = typeof data.id === "string" ? data.id : null
    if (!subscriptionId) return ignored
    return {
      eventId,
      eventType: payload.type,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  return ignored
}
