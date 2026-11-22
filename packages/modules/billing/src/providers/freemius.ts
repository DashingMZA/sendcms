import { createHmac, timingSafeEqual } from "node:crypto"
import { Freemius } from "@freemius/sdk"
import { db } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type { CheckoutArgs, CheckoutResult, VerifiedWebhook } from "./types"

const log = createLogger("billing:freemius")

// Freemius checkout. Freemius plans are created in the Freemius
// dashboard, not through the API, so the SendCMS plan version ->
// Freemius plan id mapping lives in the FREEMIUS_PLAN_MAP env var
// (JSON object: { "<planVersionId>": "<freemiusPlanId>" }). A version
// with no mapped Freemius plan cannot be sold through Freemius —
// the checkout refuses with a clear 422 instead of guessing.

function getPlanMap(): Record<string, string> {
  const raw = process.env.FREEMIUS_PLAN_MAP
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
  const checkout = await freemius.checkout.create({
    user: { email: args.customer.email },
    planId,
  })
  const url = checkout.getLink()
  if (!url) throw new ApiError("Freemius did not return a checkout URL", 502)
  return { checkoutUrl: url }
}

// Verify the Freemius webhook: HMAC-SHA256 of the raw body with the
// Product Secret Key, compared (timing-safe) against the x-signature
// header. Then translate the event. Activation comes from
// `license.created`: the license's plan_id maps back through
// FREEMIUS_PLAN_MAP to a SendCMS plan version, and the buyer's email
// resolves to the SendCMS user. Unresolvable events are ignored, not
// guessed.
export async function verifyFreemiusWebhook(
  rawBody: string,
  signature: string | null
): Promise<VerifiedWebhook> {
  const secretKey = process.env.FREEMIUS_SECRET_KEY
  if (!secretKey) throw new ApiError("Freemius is not configured", 422)
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
  const eventId =
    typeof event.id === "string" ? event.id : `freemius:${Date.now()}`
  const eventType = typeof event.type === "string" ? event.type : "unknown"
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

  if (eventType === "license.created" || eventType === "license.extended") {
    const freemiusPlanId =
      license && license.plan_id != null ? String(license.plan_id) : null
    const licenseId =
      typeof data.license_id === "string"
        ? data.license_id
        : license && typeof license.id === "string"
          ? license.id
          : null
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
    const buyer = await db.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (!buyer) {
      log.warn("Freemius webhook for an unknown buyer email", { licenseId })
      return ignored
    }
    if (eventType === "license.created") {
      return {
        eventId,
        eventType,
        event: {
          kind: "checkout-completed",
          userId: buyer.id,
          planVersionId,
          providerSubscriptionId: licenseId,
          periodEnd: null,
        },
      }
    }
    const to = typeof data.to === "string" ? data.to : null
    const periodEnd = to ? new Date(to.replace(" ", "T")) : null
    return {
      eventId,
      eventType,
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: licenseId,
        periodEnd: Number.isNaN(periodEnd?.getTime()) ? null : periodEnd,
      },
    }
  }

  if (eventType === "subscription.cancelled") {
    const subscriptionId =
      typeof data.subscription_id === "string"
        ? data.subscription_id
        : typeof data.license_id === "string"
          ? data.license_id
          : null
    if (!subscriptionId) return ignored
    return {
      eventId,
      eventType,
      event: {
        kind: "subscription-canceled",
        providerSubscriptionId: subscriptionId,
      },
    }
  }

  return ignored
}
