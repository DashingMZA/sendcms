import Stripe from "stripe"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import { assertStripeKeyMode } from "../registry"
import type { CheckoutArgs, CheckoutResult, VerifiedWebhook } from "./types"
import { isRecurring, priceInMinorUnits } from "./types"

const log = createLogger("billing:stripe")

function getClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new ApiError("Stripe is not configured", 422)
  // BIL-010: a test key in production (or vice versa) fails loudly
  // here instead of silently creating test-mode checkouts.
  assertStripeKeyMode()
  return new Stripe(secretKey)
}

// BIL-014: one idempotency key per provider call, derived from the
// checkout attempt id so a retried checkout replays the same Price /
// Session instead of creating duplicates.
function attemptKey(args: CheckoutArgs, suffix: string): string {
  const attempt = args.idempotencyKey?.trim() || "no-attempt"
  return `${attempt}:${suffix}`
}

// Stripe checkout. The Price is created on the fly from the plan
// version — no stored price mapping — and the checkout metadata
// carries the buyer + plan version so the webhook can activate the
// right subscription. Never trust client-supplied plan/price: the
// service re-reads the plan version from the DB before calling this.
export async function createStripeCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  const stripe = getClient()
  const { version, customer } = args
  const currency = version.priceCurrency.toLowerCase()
  const recurring = isRecurring(version)
  const interval = version.billingInterval === "ANNUAL" ? "year" : "month"

  const price = await stripe.prices.create(
    {
      currency,
      unit_amount: priceInMinorUnits(version),
      ...(recurring ? { recurring: { interval } } : {}),
      product_data: { name: `${version.planName} plan` },
    },
    { idempotencyKey: attemptKey(args, "price") }
  )

  const session = await stripe.checkout.sessions.create(
    {
      mode: recurring ? "subscription" : "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      customer_email: customer.email,
      client_reference_id: customer.userId,
      metadata: { userId: customer.userId, planVersionId: version.id },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      ...(recurring && version.trialDays > 0
        ? { subscription_data: { trial_period_days: version.trialDays } }
        : {}),
    },
    { idempotencyKey: attemptKey(args, "session") }
  )
  if (!session.url)
    throw new ApiError("Stripe did not return a checkout URL", 502)
  return { checkoutUrl: session.url, providerCheckoutId: session.id }
}

// Stripe API v23: the subscription moved to
// invoice.parent.subscription_details.subscription. Older payloads
// still carry `invoice.subscription`.
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscriptionField = invoice.parent?.subscription_details?.subscription
  if (typeof subscriptionField === "string") return subscriptionField
  const legacy = (invoice as { subscription?: unknown }).subscription
  return typeof legacy === "string" ? legacy : null
}

// Verify the Stripe signature on the RAW body (the route reads
// req.text(), never req.json() first) and translate the event.
export function verifyStripeWebhook(
  rawBody: string,
  signature: string | null
): VerifiedWebhook {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new ApiError("Stripe is not configured", 422)
  if (!signature) throw new ApiError("Missing Stripe signature", 401)
  const stripe = getClient()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret)
  } catch (error) {
    log.warn("Stripe webhook signature verification failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError("Invalid Stripe webhook signature", 401)
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session
    const userId = session.metadata?.userId
    const planVersionId = session.metadata?.planVersionId
    const providerSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.id
    if (!userId || !planVersionId) {
      log.warn("Stripe checkout session without SendCMS metadata", {
        sessionId: session.id,
      })
      return {
        eventId: event.id,
        eventType: event.type,
        event: { kind: "ignored" },
      }
    }
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "checkout-completed",
        userId,
        planVersionId,
        providerSubscriptionId,
        periodEnd: null,
      },
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice
    const subscriptionId = invoiceSubscriptionId(invoice)
    if (!subscriptionId) {
      return {
        eventId: event.id,
        eventType: event.type,
        event: { kind: "ignored" },
      }
    }
    const firstLine = invoice.lines?.data?.[0]
    const periodEnd =
      firstLine?.period?.end != null
        ? new Date(firstLine.period.end * 1000)
        : null
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: subscriptionId,
        periodEnd,
      },
    }
  }

  // BIL-080: a failed renewal invoice flips the subscription to
  // PAST_DUE (grace window) instead of being ignored.
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice
    const subscriptionId = invoiceSubscriptionId(invoice)
    if (!subscriptionId) {
      return {
        eventId: event.id,
        eventType: event.type,
        event: { kind: "ignored" },
      }
    }
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "payment-failed",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: subscription.id,
      },
    }
  }

  return {
    eventId: event.id,
    eventType: event.type,
    event: { kind: "ignored" },
  }
}
