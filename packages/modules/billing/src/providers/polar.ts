import {
  createPolar,
  webhooks,
  type Environment,
  type models,
} from "@polar-sh/sdk/2026-10"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type { CheckoutArgs, CheckoutResult, VerifiedWebhook } from "./types"
import { isRecurring, priceInMinorUnits } from "./types"

const log = createLogger("billing:polar")

// Polar checkout. The product is created on the fly from the plan
// version (no stored mapping) and a hosted checkout session is
// opened for it. POLAR_ENVIRONMENT is sandbox by default — live only
// when the admin sets it to "production" with a production token.
// The billing interval and the trial sit on the Polar product
// (recurring_interval / trial_interval), not on the price.

function getClient() {
  const accessToken = process.env.POLAR_ACCESS_TOKEN
  if (!accessToken) throw new ApiError("Polar is not configured", 422)
  const environment: Environment =
    process.env.POLAR_ENVIRONMENT === "production" ? "production" : "sandbox"
  return createPolar({ accessToken, environment })
}

export async function createPolarCheckoutSession(
  args: CheckoutArgs
): Promise<CheckoutResult> {
  const polar = getClient()
  const { version, customer } = args
  const currency =
    version.priceCurrency.toLowerCase() as models.PresentmentCurrency
  const recurring = isRecurring(version)
  const interval: models.RecurringInterval =
    version.billingInterval === "ANNUAL" ? "year" : "month"

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

  const checkout = await polar.checkouts.create({
    products: [product.id],
    customer_email: customer.email,
    external_customer_id: customer.userId,
    success_url: args.successUrl,
    metadata: { user_id: customer.userId, plan_version_id: version.id },
  })
  if (!checkout.url) {
    throw new ApiError("Polar did not return a checkout URL", 502)
  }
  return { checkoutUrl: checkout.url, providerCheckoutId: checkout.id }
}

// Verify the Polar webhook signature (validateEvent throws on a bad
// signature) and translate the event. Activation comes from
// `checkout.updated` with a confirmed/succeeded status: it carries
// the checkout metadata (user + plan version) and the subscription
// id. `subscription.created` is intentionally ignored — it carries
// no SendCMS metadata of its own.
export function verifyPolarWebhook(
  rawBody: string,
  headers: Record<string, string>
): VerifiedWebhook {
  const secret = process.env.POLAR_WEBHOOK_SECRET
  if (!secret) throw new ApiError("Polar is not configured", 422)
  let payload: { type: string; data: Record<string, unknown>; id?: string }
  try {
    const verified = webhooks.validateEvent(rawBody, headers, secret)
    payload = verified as unknown as {
      type: string
      data: Record<string, unknown>
      id?: string
    }
  } catch (error) {
    log.warn("Polar webhook signature verification failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw new ApiError("Invalid Polar webhook signature", 401)
  }
  const eventId =
    typeof payload.id === "string"
      ? payload.id
      : `${payload.type}:${Date.now()}`
  const ignored: VerifiedWebhook = {
    eventId,
    eventType: payload.type,
    event: { kind: "ignored" },
  }
  const data = payload.data ?? {}

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
    return ignored
  }

  if (payload.type === "order.paid") {
    const subscriptionId =
      typeof data.subscription_id === "string" ? data.subscription_id : null
    if (!subscriptionId) return ignored
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
