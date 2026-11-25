import Stripe from "stripe"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import { assertStripeKeyMode } from "../registry"
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
  priceInMinorUnits,
} from "./types"

const log = createLogger("billing:stripe")

// BIL-012: the Stripe API version is pinned explicitly. The renewal
// path reads `invoice.parent.subscription_details.subscription`, a
// shape that exists only in recent API versions — an unpinned client
// would silently follow the installed SDK's default after an
// upgrade and renewals could degrade to `ignored`. The pinned
// version is the one the installed SDK (stripe@23.2.0) defaults to
// today; bump it deliberately, with the invoice-shape tests, never
// by accident.
export const STRIPE_API_VERSION = "2026-11-18.endive" as const

// BIL-101: a misconfigured provider on the WEBHOOK path is a
// server-side problem and must be retryable — Stripe treats a 422
// as a permanent failure and drops the event, while a 503 is
// retried. The checkout/admin path keeps its 422 (it names the
// missing vars for a human); only the webhook verifiers remap.
function webhookNotConfiguredError(): ApiError {
  return new ApiError("Stripe is not configured", 503)
}

function getClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new ApiError("Stripe is not configured", 422)
  // BIL-010: a test key in production (or vice versa) fails loudly
  // here instead of silently creating test-mode checkouts.
  assertStripeKeyMode()
  // SRC-233: explicit timeout — the SDK default (80 s) used to run
  // unconfigured. 30 s matches the shared provider bound.
  // Milliseconds.
  return new Stripe(secretKey, {
    timeout: BILLING_PROVIDER_TIMEOUT_MS,
    apiVersion: STRIPE_API_VERSION,
  })
}

// BIL-014: one idempotency key per provider call, derived from the
// checkout attempt id so a retried checkout replays the same Price /
// Session instead of creating duplicates.
function attemptKey(args: CheckoutArgs, suffix: string): string {
  const attempt = args.idempotencyKey?.trim() || "no-attempt"
  return `${attempt}:${suffix}`
}

// BIL-017: one Stripe Customer per SendCMS user, created on first
// checkout and reused afterwards (the id is stored on the user by
// the billing service). A returning customer's purchases stop
// scattering across a new customer per session, and the id is what
// the Billing Portal needs.
export async function createStripeCustomer(customer: {
  email: string
  name: string | null
}): Promise<string> {
  const stripe = getClient()
  const created = await stripe.customers.create({
    email: customer.email,
    ...(customer.name ? { name: customer.name } : {}),
  })
  return created.id
}

// BIL-015 / BIL-016: read a Checkout Session back for the
// success-URL verification and the reconciliation path — the
// session carries the payment state and the SendCMS metadata, so a
// paid session whose webhook was lost can still be proven and
// activated instead of leaving a paying customer with nothing.
export async function retrieveStripeCheckoutSession(
  sessionId: string
): Promise<Stripe.Checkout.Session> {
  const stripe = getClient()
  return stripe.checkout.sessions.retrieve(sessionId)
}

// BIL-017: a Billing Portal session for the stored customer, so a
// customer can manage payment methods and cancellations at Stripe
// instead of only through SendCMS.
export async function createStripeBillingPortalSession(
  customerId: string,
  returnUrl: string
): Promise<string> {
  const stripe = getClient()
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
  return session.url
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

  // SRC-222: reuse the cached Price for this plan version when one
  // exists — every checkout used to mint a new Price, including
  // abandoned ones. A fresh Price is created once and its id is
  // returned (catalog) for the service to persist.
  let priceId = version.stripePriceId ?? null
  const catalog: NonNullable<CheckoutResult["catalog"]> = {}
  if (!priceId) {
    const price = await stripe.prices.create(
      {
        currency,
        unit_amount: priceInMinorUnits(version),
        ...(recurring ? { recurring: { interval } } : {}),
        product_data: { name: `${version.planName} plan` },
      },
      { idempotencyKey: attemptKey(args, "price") }
    )
    priceId = price.id
    catalog.stripePriceId = price.id
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: recurring ? "subscription" : "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      // BIL-017: reuse the stored customer when one exists; only
      // fall back to customer_email (which mints a new customer)
      // for a first purchase whose customer could not be stored.
      ...(args.stripeCustomerId
        ? { customer: args.stripeCustomerId }
        : { customer_email: customer.email }),
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
  return {
    checkoutUrl: session.url,
    providerCheckoutId: session.id,
    ...(Object.keys(catalog).length > 0 ? { catalog } : {}),
  }
}

// BIL-001 / BIL-082: cancel at the provider, so billing actually
// stops. A provider failure is a 502 — the caller must NOT flip the
// local row to CANCELED while Stripe keeps charging.
export async function cancelStripeSubscription(
  args: ProviderCancelArgs
): Promise<ProviderCancelOutcome> {
  const stripe = getClient()
  try {
    if (args.cancelAtPeriodEnd) {
      await stripe.subscriptions.update(args.providerSubscriptionId, {
        cancel_at_period_end: true,
      })
      return { canceledAtProvider: true, immediate: false }
    }
    await stripe.subscriptions.cancel(args.providerSubscriptionId)
    return { canceledAtProvider: true, immediate: true }
  } catch (error) {
    log.warn("Stripe subscription cancel failed", {
      subscriptionId: args.providerSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError(
      "The payment provider could not cancel the subscription. Please try again.",
      502
    )
  }
}

// BIL-089: move a Stripe subscription onto a new plan version's
// price (with proration), so a migration changes what the customer
// is actually billed — not just what SendCMS grants.
export async function updateStripeSubscriptionPlan(
  providerSubscriptionId: string,
  version: {
    planName: string
    priceAmount: number | null
    priceCurrency: string
    billingInterval: string
    trialDays: number
  }
): Promise<ProviderUpdateOutcome> {
  const stripe = getClient()
  try {
    const subscription = await stripe.subscriptions.retrieve(
      providerSubscriptionId
    )
    const item = subscription.items.data[0]
    if (!item) {
      return {
        updated: false,
        reason: "The Stripe subscription has no line item to reprice.",
      }
    }
    const recurring =
      version.billingInterval === "MONTHLY" ||
      version.billingInterval === "ANNUAL"
    const interval = version.billingInterval === "ANNUAL" ? "year" : "month"
    const price = await stripe.prices.create({
      currency: version.priceCurrency.toLowerCase(),
      unit_amount: version.priceAmount ?? 0,
      ...(recurring ? { recurring: { interval } } : {}),
      product_data: { name: `${version.planName} plan` },
    })
    await stripe.subscriptions.update(providerSubscriptionId, {
      items: [{ id: item.id, price: price.id }],
      proration_behavior: "create_prorations",
    })
    return { updated: true }
  } catch (error) {
    log.warn("Stripe subscription plan update failed", {
      subscriptionId: providerSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError(
      "The payment provider could not change the subscription plan. Please try again.",
      502
    )
  }
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

// Stripe API 2025+ (SDK v23): Subscription no longer carries
// `current_period_end` — the period lives on each subscription
// item. SendCMS subscriptions have one item; the first item's end
// is the period end. (An item-less subscription has no period end
// to sync, so null is the honest answer.)
function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const end = subscription.items?.data[0]?.current_period_end
  return end != null ? new Date(end * 1000) : null
}

// Verify the Stripe signature on the RAW body (the route reads
// req.text(), never req.json() first) and translate the event.
export function verifyStripeWebhook(
  rawBody: string,
  signature: string | null
): VerifiedWebhook {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  // BIL-101: 503, not 422 — a missing webhook secret is a
  // server-side misconfiguration Stripe must retry, not a
  // permanent client error.
  if (!secret) throw webhookNotConfiguredError()
  if (!signature) throw new ApiError("Missing Stripe signature", 401)
  let stripe: Stripe
  try {
    stripe = getClient()
  } catch (error) {
    // A missing secret key is the same retryable misconfiguration.
    if (error instanceof ApiError && error.status === 422) {
      throw webhookNotConfiguredError()
    }
    throw error
  }
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
    // BIL-003: a one-time checkout (mode "payment") has no
    // subscription — the refund-matchable reference is the
    // payment_intent, and the session id is kept as checkoutId.
    // A recurring checkout stores the subscription id, as before.
    const isOneTime =
      session.mode === "payment" || typeof session.subscription !== "string"
    const paymentIntent =
      typeof session.payment_intent === "string" ? session.payment_intent : null
    const providerSubscriptionId = isOneTime
      ? (paymentIntent ?? session.id)
      : (session.subscription as string)
    if (!userId || !planVersionId) {
      log.warn("Stripe checkout session without SendCMS metadata", {
        sessionId: session.id,
      })
      // BIL-100: a PAID checkout with no metadata is not "ignored"
      // — the customer paid and nothing can activate them. It
      // becomes an unmapped-payment: recorded, left unprocessed,
      // and visible in the admin reconciliation queue.
      return {
        eventId: event.id,
        eventType: event.type,
        event: {
          kind: "unmapped-payment",
          providerCheckoutId: session.id,
          reason:
            "Checkout session has no SendCMS metadata (userId/planVersionId)",
        },
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
        ...(isOneTime
          ? {
              isOneTime: true,
              providerReference: providerSubscriptionId,
              checkoutId: session.id,
            }
          : {}),
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
    // BIL-026: the period end comes from the invoice line that
    // belongs to THIS subscription — the first line need not be
    // the subscription line on multi-line or prorated invoices.
    // A lineless invoice, or one with no line for the
    // subscription, is unprocessable rather than silently
    // extended: it becomes an unmapped-payment for the
    // reconciliation queue (extending blindly would grant an
    // extra period on top of the one activation already granted).
    const lines = invoice.lines?.data ?? []
    const matchingLine = lines.find((line) => {
      // Stripe API 2025+ (SDK v23): an invoice line carries its
      // subscription directly (`line.subscription`), not via
      // `line.parent.subscription_details` — that shape exists on
      // the INVOICE parent, not on a line's parent (which has
      // `subscription_item_details`, an item id, not a subscription
      // id). An expanded subscription object is matched by id.
      // The parent shape is also accepted as a fallback
      // (`parent.subscription_item_details.subscription`), per the
      // SDK's InvoiceLineItemParent type.
      const lineSub = line.subscription
      if (typeof lineSub === "string" && lineSub === subscriptionId) {
        return true
      }
      if (
        lineSub &&
        typeof lineSub === "object" &&
        lineSub.id === subscriptionId
      ) {
        return true
      }
      const parentSub = (
        line as {
          parent?: {
            subscription_item_details?: { subscription?: unknown }
          }
        }
      ).parent?.subscription_item_details?.subscription
      return typeof parentSub === "string" && parentSub === subscriptionId
    })
    if (!matchingLine) {
      log.warn("Stripe invoice.paid without a subscription line", {
        invoiceId: invoice.id,
        subscriptionId,
        lineCount: lines.length,
      })
      return {
        eventId: event.id,
        eventType: event.type,
        event: {
          kind: "unmapped-payment",
          providerSubscriptionId: subscriptionId,
          reason:
            lines.length === 0
              ? "Invoice has no lines"
              : "Invoice has no line for the subscription",
        },
      }
    }
    const periodEnd =
      matchingLine.period?.end != null
        ? new Date(matchingLine.period.end * 1000)
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

  // BIL-005: provider-side subscription changes reach SendCMS.
  // `created` activates from the checkout metadata (subscriptions
  // created outside Checkout — dashboard, Billing Portal); `updated`
  // syncs status / period end / cancel-at-period-end, and maps
  // past_due / unpaid to a payment failure (BIL-002).
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated"
  ) {
    const subscription = event.data.object as Stripe.Subscription
    const status = subscription.status
    if (status === "canceled") {
      return {
        eventId: event.id,
        eventType: event.type,
        event: {
          kind: "subscription-canceled",
          providerSubscriptionId: subscription.id,
        },
      }
    }
    if (status === "past_due" || status === "unpaid") {
      return {
        eventId: event.id,
        eventType: event.type,
        event: {
          kind: "payment-failed",
          providerSubscriptionId: subscription.id,
        },
      }
    }
    if (event.type === "customer.subscription.created") {
      const userId = subscription.metadata?.userId
      const planVersionId = subscription.metadata?.planVersionId
      if (userId && planVersionId) {
        return {
          eventId: event.id,
          eventType: event.type,
          event: {
            kind: "checkout-completed",
            userId,
            planVersionId,
            providerSubscriptionId: subscription.id,
            periodEnd: subscriptionPeriodEnd(subscription),
          },
        }
      }
      // No SendCMS metadata: nothing to activate from — the sync
      // below still records the subscription id for the admin
      // timeline when a row exists.
    }
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "subscription-updated",
        providerSubscriptionId: subscription.id,
        status,
        periodEnd: subscriptionPeriodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null,
      },
    }
  }

  // BIL-004 / BIL-081 (owner decision 2026-11-25): refunds and
  // chargebacks. `amount_refunded` vs `amount` decides full vs
  // partial exactly. The charge's invoice carries the subscription
  // when expanded; otherwise the service resolves via the payment
  // intent against one-time purchases (a recurring refund with no
  // subscription id is recorded unresolved — see handleWebhook).
  if (
    event.type === "charge.refunded" ||
    event.type === "charge.dispute.created" ||
    event.type === "refund.created"
  ) {
    const charge = event.data.object as Stripe.Charge & {
      invoice?: string | { subscription?: unknown }
    }
    const invoice = charge.invoice
    const subscriptionId =
      invoice && typeof invoice === "object"
        ? typeof invoice.subscription === "string"
          ? invoice.subscription
          : null
        : null
    const amount = typeof charge.amount === "number" ? charge.amount : null
    const refunded =
      typeof charge.amount_refunded === "number" ? charge.amount_refunded : null
    const paymentIntent =
      typeof charge.payment_intent === "string" ? charge.payment_intent : null
    return {
      eventId: event.id,
      eventType: event.type,
      event: {
        kind: "payment-refunded",
        providerSubscriptionId: subscriptionId,
        providerReference: paymentIntent,
        // A dispute is a full clawback of the charge by definition.
        fullRefund:
          event.type === "charge.dispute.created" ||
          (amount !== null && refunded !== null ? refunded >= amount : true),
        amountMinor: refunded,
      },
    }
  }

  return {
    eventId: event.id,
    eventType: event.type,
    event: { kind: "ignored" },
  }
}
