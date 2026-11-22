import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type { CheckoutArgs, CheckoutResult, VerifiedWebhook } from "./types"
import { isRecurring, priceAsDecimal } from "./types"

const log = createLogger("billing:paypal")

// PayPal runs on direct REST calls: the official server SDK (v2.5)
// has no catalog controller, so products and billing plans cannot be
// created through it. Same endpoints the SDK would call, same shape.
// PAYPAL_MODE is sandbox by default — live only when the admin sets
// it to "live" with live credentials.

function baseUrl(): string {
  return process.env.PAYPAL_MODE === "live"
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

async function paypalFetch(
  path: string,
  method: "GET" | "POST",
  accessToken: string | null,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!res.ok) {
    const detail =
      (json?.message as string | undefined) ??
      (json?.error_description as string | undefined) ??
      `PayPal request failed (${res.status})`
    throw new ApiError(detail, 502)
  }
  return json
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret } = credentials()
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  })
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!res.ok || typeof json?.access_token !== "string") {
    throw new ApiError("PayPal authentication failed", 502)
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
  name: string
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
    }
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
  const created = (await paypalFetch("/v1/billing/plans", "POST", accessToken, {
    product_id: productId,
    name: `${version.planName} plan`,
    status: "ACTIVE",
    billing_cycles: cycles,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 3,
    },
  })) as { id?: string }
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
      }
    )) as { id?: string; links?: PayPalLink[] }
    const url = approveLink(order.links)
    if (!order.id || !url) {
      throw new ApiError("PayPal did not return a checkout URL", 502)
    }
    return { checkoutUrl: url, providerCheckoutId: order.id }
  }

  const productId = await createProduct(accessToken, `${version.planName} plan`)
  const planId = await createPlan(accessToken, productId, args)
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
    }
  )) as { id?: string; links?: PayPalLink[] }
  const url = approveLink(subscription.links)
  if (!subscription.id || !url) {
    throw new ApiError("PayPal did not return a checkout URL", 502)
  }
  return { checkoutUrl: url, providerCheckoutId: subscription.id }
}

// Verify the webhook with PayPal's verify-webhook-signature endpoint
// and translate the event. The caller passes the raw body string and
// the headers it received.
export async function verifyPayPalWebhook(
  rawBody: string,
  headers: Record<string, string>
): Promise<VerifiedWebhook> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!webhookId) throw new ApiError("PayPal is not configured", 422)
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

  const accessToken = await getAccessToken()
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
    }
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
    if (!customId || !subscriptionId) return ignored
    const [userId, planVersionId] = customId.split(":")
    if (!userId || !planVersionId) return ignored
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
    if (!customId || !orderId) return ignored
    const [userId, planVersionId] = customId.split(":")
    if (!userId || !planVersionId) return ignored
    return {
      eventId: event.id,
      eventType: event.event_type,
      event: {
        kind: "checkout-completed",
        userId,
        planVersionId,
        providerSubscriptionId: orderId,
        periodEnd: null,
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

  return ignored
}
