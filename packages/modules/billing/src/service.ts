import { randomUUID } from "node:crypto"
import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  Prisma,
  db,
  type BillingProvider,
} from "@sendcms/database"
import { requireAdmin, type PlatformCapability } from "@sendcms/permissions"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import {
  validateCouponForCheckout,
  type CouponValidation,
} from "@sendcms/coupons"
import {
  activateSubscriptionFromCheckout,
  applyRefund,
  cancelSubscriptionFromProvider,
  extendSubscriptionPeriod,
  markSubscriptionPastDue,
  syncSubscriptionFromProvider,
} from "@sendcms/plans"
import {
  BILLING_PROVIDERS,
  getBillingProviderDefinition,
  isProviderConfigured,
  missingEnvVars,
} from "./registry"
import {
  FREEMIUS_REPLAY_WINDOW_MS,
  createCheckoutForProvider,
  createStripeBillingPortalSession,
  createStripeCustomer,
  getFreemiusPlanMapCount,
  retrievePayPalOrder,
  retrievePayPalSubscription,
  retrieveStripeCheckoutSession,
  verifyWebhookForProvider,
} from "./providers"
import type { PlanVersionForCheckout, VerifiedWebhook } from "./providers/types"
import {
  billingEventKindFor,
  validatePriceForCheckout,
} from "./providers/types"
import type {
  BillingEventsQuery,
  CheckoutAttemptsQuery,
  CheckoutSessionInput,
  ReconcileCheckoutInput,
  SetProviderConfigInput,
} from "./validators"

const log = createLogger("billing")

// BIL-025: the dashboard URL backs the checkout success/cancel URLs
// and the Billing Portal return URL. In production an unset var used
// to silently redirect paying customers to http://localhost:3002 —
// now it fails loudly at checkout time instead. Dev/test keep the
// localhost fallback.
function dashboardBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_DASHBOARD_URL?.trim()
  if (configured) return configured.replace(/\/+$/, "")
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(
      "NEXT_PUBLIC_DASHBOARD_URL is not set — the checkout return URL cannot be built.",
      422
    )
  }
  return "http://localhost:3002"
}

// Billing admin + checkout service (Admin Control Plane, Phase 8).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes:
// admin functions take the actor's AdminSession first and enforce
// their capability (VIEW_BILLING reads, MANAGE_BILLING writes).
// Customer checkout takes the signed-in user's session actor.
//
// The core invariants:
// - A provider can be enabled ONLY when its env credentials exist.
//   Enabling an unconfigured provider is a 422 naming the missing
//   vars. Disabling is always allowed and never breaks existing
//   subscriptions — renewal webhooks keep working for a disabled
//   provider (only NEW checkouts are refused).
// - NO mapping rows for a provider = all countries (the default).
//   The admin sets per-provider countries from the admin app; the
//   intended defaults (Stripe everywhere, PayPal US/GB/AU/DE and
//   friends, Gumroad PK) are admin choices, never hardcoded here —
//   they are seeded by migration
//   20261124154600_seed_billing_provider_countries (BIL-125), and the
//   admin can change any provider's countries afterwards.
// - Webhook events are idempotent on (provider, providerEventId):
//   an already-processed event id is skipped, never applied twice.
// - Never trust client-supplied plan/price: the checkout re-reads
//   the plan version from the DB, and the webhook re-reads it too
//   (via the activation function), so a tampered request cannot buy
//   a cheaper plan or activate a different one.

// ─── Authorization ────────────────────────────────────────────────────

// `requireBillingAdmin` keeps its name as a thin wrapper over the
// shared gate in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215): same body, same 403, one implementation.
export function requireBillingAdmin(
  session: AdminSession,
  capability: PlatformCapability
): void {
  requireAdmin(session, capability)
}

// ─── Types ────────────────────────────────────────────────────────────

export type BillingProviderConfigRow = {
  provider: BillingProvider
  isEnabled: boolean
  configured: boolean
  missingEnvVars: string[]
  checkoutImplemented: boolean
  // ISO alpha-2 codes the provider is restricted to; empty = everywhere.
  countries: string[]
  allCountries: boolean
  // BIL-053: Freemius only — how many plan versions FREEMIUS_PLAN_MAP
  // maps (null for the other providers, which have no plan map). The
  // map itself is env JSON, not DB rows, so the row only surfaces the
  // count; the mapping stays in the env var.
  planMapCount: number | null
  // BIL-053: set only by setProviderConfig when Freemius is enabled
  // with an empty plan map — the enable succeeds, but no Freemius
  // checkout can work until a version is mapped.
  warning?: string
  // BIL-095: Gumroad has no checkout API and no webhook route, so
  // the admin UI shows this note under the provider instead of a
  // dead "checkout available" badge. Null for the other providers.
  note: string | null
}

export type BillingEventRow = {
  id: string
  provider: BillingProvider
  providerEventId: string
  eventType: string
  // Phase 16, Wave 6 (BIL-092 completion): the customer the event
  // belongs to, when the webhook payload identifies one; null for
  // ignored events and events for subscriptions SendCMS never saw.
  userId: string | null
  // processedAt set = the webhook was applied; null = the event was
  // received but never applied (failed apply, or a duplicate that
  // arrived while the first delivery was still in flight).
  processed: boolean
  processedAt: Date | null
  createdAt: Date
}

export type EnabledBillingProvider = {
  provider: BillingProvider
  checkoutImplemented: boolean
}

// BIL-028: one row of the admin checkout-attempts list — the
// support record of a checkout creation (see CheckoutAttempt).
export type CheckoutAttemptRow = {
  id: string
  attemptId: string
  userId: string | null
  planVersionId: string
  provider: BillingProvider
  providerCheckoutId: string | null
  priceAmount: number | null
  priceCurrency: string
  status: "CREATED" | "COMPLETED" | "FAILED"
  createdAt: Date
}

function toConfigRow(
  config: {
    provider: BillingProvider
    isEnabled: boolean
    countries: { countryCode: string }[]
  },
  env: NodeJS.ProcessEnv = process.env
): BillingProviderConfigRow {
  const definition = getBillingProviderDefinition(config.provider)
  const countries = config.countries.map((c) => c.countryCode)
  return {
    provider: config.provider,
    isEnabled: config.isEnabled,
    configured: isProviderConfigured(config.provider, env),
    missingEnvVars: missingEnvVars(config.provider, env),
    checkoutImplemented: definition.checkoutImplemented,
    countries,
    allCountries: countries.length === 0,
    planMapCount:
      config.provider === "FREEMIUS" ? getFreemiusPlanMapCount(env) : null,
    note: definition.note ?? null,
  }
}

// ─── Admin: provider configs ──────────────────────────────────────────

// List all five provider configs. Pure read — the rows are seeded by
// migration 20261124154500_seed_billing_provider_configs (BIL-129), so
// this endpoint never writes; a row missing from the DB (migration not
// applied yet, or a row deleted out of band) is presented as disabled
// with no countries, never created here. Country defaults are seeded
// separately (20261124154600, BIL-125) and are admin-editable, never
// hardcoded in this service.
export async function listProviderConfigs(
  actor: AdminSession
): Promise<BillingProviderConfigRow[]> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const configs = await db.billingProviderConfig.findMany({
    include: { countries: { select: { countryCode: true } } },
    orderBy: { provider: "asc" },
  })
  // Present in the user-approved provider order, not enum order.
  const byId = new Map(configs.map((c) => [c.provider, c]))
  return BILLING_PROVIDERS.map((definition) =>
    toConfigRow(
      byId.get(definition.id) ?? {
        provider: definition.id,
        isEnabled: false,
        countries: [],
      }
    )
  )
}

// The full country list, from the DB table — the admin UI fetches it
// from the route and shows it as the multi-select options.
export async function listCountries(
  actor: AdminSession
): Promise<{ code: string; name: string }[]> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  return db.country.findMany({
    select: { code: true, name: true },
    orderBy: { name: "asc" },
  })
}

// Same list, no admin check — the checkout page's country select and
// the public countries endpoint. Country names are public data.
export async function listPublicCountries(): Promise<
  { code: string; name: string }[]
> {
  return db.country.findMany({
    select: { code: true, name: true },
    orderBy: { name: "asc" },
  })
}

// ─── Admin: billing events (webhook / transaction history) ────────────────

// The shared filter shape for both billing-event lists (admin +
// customer): provider / event type / processed state / date bounds.
// The customer list adds `userId` — the owner scope — and nothing
// else can widen it.
function billingEventsWhere(
  filters: BillingEventsQuery,
  userId?: string
): Prisma.BillingEventWhereInput {
  const where: Prisma.BillingEventWhereInput = {}
  if (userId) where.userId = userId
  if (filters.provider) where.provider = filters.provider
  if (filters.eventType) where.eventType = filters.eventType
  if (filters.processed !== undefined) {
    where.processedAt = filters.processed === true ? { not: null } : null
  }
  const createdAt: Prisma.DateTimeFilter = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt
  return where
}

function toBillingEventRow(row: {
  id: string
  provider: BillingProvider
  providerEventId: string
  eventType: string
  userId: string | null
  processedAt: Date | null
  createdAt: Date
}): BillingEventRow {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    userId: row.userId,
    processed: row.processedAt !== null,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  }
}

// ADM-123 / BIL-123 / BIL-092: the read side BillingEvent never had.
// Webhook receipts + payment events, newest first, paginated, filterable
// by provider / event type / processed state / date. An unprocessed row
// (processedAt null) is one the webhook handler received but never
// applied — a failed apply, or a duplicate that arrived while the first
// delivery was still in flight. Duplicate deliveries never create a
// second row (unique (provider, providerEventId)), so the single row
// and its processed state are the record of the delivery.
export async function listBillingEvents(
  actor: AdminSession,
  filters: BillingEventsQuery
): Promise<{
  events: BillingEventRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const where = billingEventsWhere(filters)
  const [total, rows] = await Promise.all([
    db.billingEvent.count({ where }),
    db.billingEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    events: rows.map(toBillingEventRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

// ─── Customer: own billing events (BIL-092 completion, Wave 6) ────────────

// The customer payment-history view. Owner-scoped by construction:
// the only user id is the caller's, so a customer sees only their own
// events — another customer's rows are never in the result, whatever
// filters are passed. Same pagination/filter shape as the admin list.
export async function listMyBillingEvents(
  userId: string,
  filters: BillingEventsQuery
): Promise<{
  events: BillingEventRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  const where = billingEventsWhere(filters, userId)
  const [total, rows] = await Promise.all([
    db.billingEvent.count({ where }),
    db.billingEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    events: rows.map(toBillingEventRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

// Enable/disable a provider and/or set its countries, in one call.
// `countries: []` (empty list) clears the mapping = everywhere.
export async function setProviderConfig(
  actor: AdminSession,
  provider: BillingProvider,
  input: SetProviderConfigInput
): Promise<BillingProviderConfigRow> {
  requireBillingAdmin(actor, "MANAGE_BILLING")
  const reason = input.reason.trim()
  if (!reason) throw new ApiError("A reason is required", 422)
  const definition = getBillingProviderDefinition(provider)

  if (input.isEnabled === true && !isProviderConfigured(provider)) {
    const missing = missingEnvVars(provider)
    throw new ApiError(
      `Cannot enable ${definition.label}: missing environment variables: ${missing.join(", ")}`,
      422
    )
  }

  let countries: string[] | undefined
  if (input.countries !== undefined) {
    const known = new Set(
      (await db.country.findMany({ select: { code: true } })).map((c) => c.code)
    )
    const unknown = [...new Set(input.countries)].filter((c) => !known.has(c))
    if (unknown.length > 0) {
      throw new ApiError(`Unknown country codes: ${unknown.join(", ")}`, 422)
    }
    countries = [...new Set(input.countries)]
  }

  const { oldRow, updated } = await db.$transaction(async (tx) => {
    // DB-051: the config row is locked before it is read, so the
    // audit's old value is the value this write actually replaces —
    // a concurrent change between the read and the write cannot make
    // it stale.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BillingProviderConfig" WHERE "provider" = ${provider} FOR UPDATE
    `
    const existing =
      locked.length > 0
        ? await tx.billingProviderConfig.findUnique({
            where: { provider },
            include: { countries: { select: { countryCode: true } } },
          })
        : null
    const oldRow = existing ? toConfigRow(existing) : null
    const config = await tx.billingProviderConfig.upsert({
      where: { provider },
      update: {
        ...(input.isEnabled !== undefined
          ? { isEnabled: input.isEnabled }
          : {}),
      },
      create: { provider, isEnabled: input.isEnabled ?? false },
    })
    if (countries !== undefined) {
      await tx.billingProviderCountry.deleteMany({
        where: { providerConfigId: config.id },
      })
      if (countries.length > 0) {
        await tx.billingProviderCountry.createMany({
          data: countries.map((code) => ({
            providerConfigId: config.id,
            countryCode: code,
          })),
        })
      }
    }
    const updated = await tx.billingProviderConfig.findUniqueOrThrow({
      where: { provider },
      include: { countries: { select: { countryCode: true } } },
    })
    return { oldRow, updated }
  })

  const newRow = toConfigRow(updated)
  // BIL-053: enabling Freemius with no mapped plan version succeeds,
  // but every Freemius checkout will 422 until a version is mapped —
  // say so in the response instead of failing silently at a
  // customer's checkout attempt.
  const warning =
    provider === "FREEMIUS" &&
    input.isEnabled === true &&
    newRow.planMapCount === 0
      ? "No Freemius plan is mapped yet — Freemius checkout will refuse every plan version until FREEMIUS_PLAN_MAP maps at least one."
      : undefined
  const row: BillingProviderConfigRow = warning
    ? { ...newRow, warning }
    : newRow
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.BILLING_PROVIDER,
    resourceId: provider,
    detail: {
      event: "billing-provider-config-changed",
      reason,
      old: oldRow
        ? { isEnabled: oldRow.isEnabled, countries: oldRow.countries }
        : null,
      new: { isEnabled: newRow.isEnabled, countries: newRow.countries },
      ...(warning ? { warning } : {}),
    },
  })
  return row
}

// ─── Customer: enabled providers + checkout ───────────────────────────

// Providers a customer may check out with: enabled AND configured
// AND (no country mapping OR mapped for this country). With no
// country given, the country filter is skipped. Ordered Stripe,
// PayPal, Polar, Freemius, Gumroad.
//
// BIL-095: providers without a checkout implementation (Gumroad —
// no payment-creation API) are never listed to customers, even
// when enabled in admin: listing one would offer a checkout that
// cannot exist. The admin list (listProviderConfigs) still shows
// them, with the manual-activation note.
export async function listEnabledProviders(
  countryCode?: string | null
): Promise<EnabledBillingProvider[]> {
  const normalized = countryCode?.trim().toUpperCase() || null
  const configs = await db.billingProviderConfig.findMany({
    where: { isEnabled: true },
    include: { countries: { select: { countryCode: true } } },
  })
  const result: EnabledBillingProvider[] = []
  for (const definition of BILLING_PROVIDERS) {
    if (!definition.checkoutImplemented) continue
    const config = configs.find((c) => c.provider === definition.id)
    if (!config) continue
    if (!isProviderConfigured(definition.id)) continue
    if (
      normalized &&
      config.countries.length > 0 &&
      !config.countries.some((c) => c.countryCode === normalized)
    ) {
      continue
    }
    result.push({
      provider: definition.id,
      checkoutImplemented: definition.checkoutImplemented,
    })
  }
  return result
}

async function requireProviderAvailable(
  provider: BillingProvider,
  countryCode?: string | null
): Promise<void> {
  const definition = getBillingProviderDefinition(provider)
  const config = await db.billingProviderConfig.findUnique({
    where: { provider },
    include: { countries: { select: { countryCode: true } } },
  })
  if (!config?.isEnabled) {
    throw new ApiError(`${definition.label} is not enabled`, 422)
  }
  // BIL-121 (Wave 8, Stream A test): the country restriction is
  // checked BEFORE the env configuration — a customer in a blocked
  // country gets "not available in your country" (actionable for
  // them: pick another method) instead of an admin-setup error
  // they cannot act on. The mapping lives in the DB config, so it
  // is available even when the env vars are not.
  const normalized = countryCode?.trim().toUpperCase() || null
  if (
    normalized &&
    config.countries.length > 0 &&
    !config.countries.some((c) => c.countryCode === normalized)
  ) {
    throw new ApiError(
      `${definition.label} is not available in your country`,
      422
    )
  }
  if (!isProviderConfigured(provider)) {
    const missing = missingEnvVars(provider)
    throw new ApiError(
      `${definition.label} is not configured: missing environment variables: ${missing.join(", ")}`,
      422
    )
  }
  if (!definition.checkoutImplemented) {
    throw new ApiError(
      `Checkout is not available for ${definition.label}: it has no payment-creation API`,
      422
    )
  }
}

// Start a hosted checkout for the signed-in user. The plan version is
// re-read from the DB (never trusted from the client), free plans
// refuse with 422 (no payment needed), and the provider must be
// enabled + configured + available in the customer's country.
//
// BIL-121: the country is ENFORCED, not self-declared. The route
// passes `opts.detectedCountry` from the geo headers (null when
// detection is unavailable — XX/T1/missing). When detection
// succeeds, the client's `countryCode` must match it (422 on
// mismatch) and the detected country decides provider availability;
// when detection is null, the client-supplied country is the
// fallback (the Phase 8 manual-select decision, kept only for the
// no-detection case). Judgment call (2026-11-25, Wave 8 Stream A):
// strict-when-detected + manual fallback only when detection is
// null — geo headers are the platform's own signal (the same one
// the checkout page prefills from), a mismatch is a deliberate
// override attempt, and refusing it is what the per-provider
// country configuration exists for. The enforced country is
// recorded in the checkout attempt id's audit trail via the
// provider call's metadata path (the checkout itself is a hosted
// redirect, so the audit row is the BillingEvent written when the
// provider calls back).
export async function createCheckoutSession(
  actor: AdminSession,
  input: CheckoutSessionInput,
  opts: {
    detectedCountry?: string | null
    // BIL-057: the client IP the route observed (x-forwarded-for /
    // cf-connecting-ip), forwarded to Polar as customer_ip_address.
    clientIpAddress?: string | null
  } = {}
): Promise<{
  checkoutUrl: string
  provider: BillingProvider
  // BIL-014: the attempt id the provider calls were keyed on — the
  // client reuses it when retrying a double-submit.
  attemptId: string
  // BIL-028: the provider checkout id (Stripe session / PayPal
  // order id), for the support lookup — null when the provider did
  // not return one.
  providerCheckoutId: string | null
}> {
  const version = await db.planVersion.findUnique({
    where: { id: input.planVersionId },
    include: { plan: { select: { name: true } } },
  })
  if (!version) throw new ApiError("Plan version not found", 404)
  if (version.status !== "PUBLISHED") {
    throw new ApiError("This plan version is not published", 409)
  }
  if (version.priceAmount == null || version.priceAmount <= 0) {
    throw new ApiError(
      "This plan is free and needs no payment — take it from the checkout page instead.",
      422
    )
  }
  const detected = opts.detectedCountry?.trim().toUpperCase() || null
  const claimed = input.countryCode?.trim().toUpperCase() || null
  if (detected && claimed && claimed !== detected) {
    throw new ApiError(
      `Country mismatch: your location was detected as ${detected}, but the checkout claimed ${claimed}.`,
      422
    )
  }
  // Detected wins when present; the manual value is only the
  // fallback when detection is unavailable.
  const effectiveCountry = detected ?? claimed
  await requireProviderAvailable(input.provider, effectiveCountry)

  // ─── Phase D (Coupons, Q6/Q7) ──────────────────────────────────
  // Optional platform coupon, validated AFTER the plan version and
  // provider are known and BEFORE the attempt is recorded — a failed
  // validation aborts the checkout with the coupons service's 422
  // (propagated unchanged, customer-safe message) and no attempt
  // is ever marked COMPLETED with a discount it never earned.
  // Amounts are minor units everywhere, never floats.
  //
  // Per-provider behaviour (Q7: platform-only codes in v1 — no
  // provider-native coupon APIs are called):
  // - STRIPE / PAYPAL / POLAR: the provider session is created for
  //   the DISCOUNTED price. The price-carrying catalog object is
  //   minted fresh for this checkout (cached Stripe Price /
  //   PayPal billing plan / Polar product are cleared from the
  //   version passed down — they carry the FULL price) and the
  //   fresh ids are deliberately NOT persisted back onto the plan
  //   version (see the catalog block below): a discounted Price
  //   must never become the version's cached full-price object.
  //   PayPal's cached *product* is reused — a product carries no
  //   price; only its billing plan does.
  // - FREEMIUS: refused outright. The Freemius plan price is fixed
  //   in the Freemius dashboard and cross-checked against the
  //   version before sale (checkFreemiusPlanPrice), so a discounted
  //   checkout could never be honoured at the provider — refusing
  //   here is the fail-safe instead of charging full price while
  //   recording a discount.
  // - GUMROAD: already refused by requireProviderAvailable (no
  //   payment-creation API).
  //
  // A 100% discount (final amount 0) is NOT a free-plan bypass: it
  // refuses with 422 instead of creating a $0 provider session or
  // granting without payment.
  let coupon: CouponValidation | null = null
  let chargedAmount = version.priceAmount
  const rawCouponCode = input.couponCode?.trim() || null
  if (rawCouponCode) {
    if (input.provider === "FREEMIUS") {
      throw new ApiError(
        "Coupon codes are not supported for Freemius checkout — choose another payment method.",
        422
      )
    }
    coupon = await validateCouponForCheckout({
      code: rawCouponCode,
      userId: actor.user.id,
      planVersionId: version.id,
      priceAmountMinor: version.priceAmount,
      currency: version.priceCurrency,
    })
    if (coupon.discountAmountMinor <= 0) {
      // A "valid" code that discounts nothing changes nothing —
      // treat the checkout as coupon-free instead of recording a
      // zero-discount coupon on the attempt.
      coupon = null
    } else if (coupon.finalAmountMinor <= 0) {
      throw new ApiError(
        "This coupon covers the full price — contact support to apply it.",
        422
      )
    } else {
      chargedAmount = coupon.finalAmountMinor
    }
  }

  const dashboardUrl = dashboardBaseUrl()
  // BIL-015: Stripe's success URL carries the session id
  // ({CHECKOUT_SESSION_ID} is substituted by Stripe), so the
  // dashboard can VERIFY the payment against Stripe instead of
  // trusting the bare `checkout=success` query param. PayPal
  // appends subscription_id / token itself; Polar and Freemius
  // return to the same URL without an id.
  const successUrl =
    input.provider === "STRIPE"
      ? `${dashboardUrl}/dashboard/billing?checkout=success&provider=stripe&session_id={CHECKOUT_SESSION_ID}`
      : `${dashboardUrl}/dashboard/billing?checkout=success&provider=${input.provider.toLowerCase()}`
  const cancelUrl = `${dashboardUrl}/dashboard/billing/checkout?planVersionId=${version.id}&cancelled=1`
  // SRC-222: the checkout reuses the provider catalog objects
  // already cached on this plan version (Stripe Price, PayPal
  // product + plan, Polar product) instead of minting throwaway
  // objects on every click; ids created by this checkout are
  // persisted afterwards (see below).
  const checkoutVersion: PlanVersionForCheckout = {
    id: version.id,
    planId: version.planId,
    planName: version.plan.name,
    // Phase D: the DISCOUNTED amount is what gets charged — the
    // provider session is priced from this, not the version's full
    // price. The price-carrying catalog ids are cleared when a
    // coupon applies (see the coupon block above): Stripe reuses a
    // cached Price and PayPal a cached billing plan, both of which
    // carry the full price, and Polar's product carries its price —
    // a discounted checkout must mint fresh ones.
    priceAmount: chargedAmount,
    priceCurrency: version.priceCurrency,
    billingInterval: version.billingInterval,
    trialDays: version.trialDays,
    stripePriceId: coupon ? undefined : (version.stripePriceId ?? undefined),
    paypalProductId: version.paypalProductId ?? undefined,
    paypalPlanId: coupon ? undefined : (version.paypalPlanId ?? undefined),
    polarProductId: coupon ? undefined : (version.polarProductId ?? undefined),
  }
  // BIL-027 / BIL-011 / BIL-056: the price is validated against
  // the provider's rules BEFORE any provider call — zero-decimal
  // currencies (JPY etc.) in whole units, below-minimum prices,
  // and invalid currency codes refuse with a named 422 instead of
  // a provider 400 or a silently wrong amount. Validated on the
  // DISCOUNTED price when a coupon applies: a discount that drops
  // the charge below the provider minimum refuses here, it is not
  // silently rounded up or charged at the minimum.
  const priceError = validatePriceForCheckout(checkoutVersion)
  if (priceError) throw new ApiError(priceError, 422)
  const attemptId = input.attemptId ?? randomUUID()
  // BIL-017: one Stripe Customer per user. The stored id is
  // reused; a first purchase creates the customer and stores the
  // id (best-effort store — a failed write only means the next
  // checkout creates a second lookup, never a blocked purchase).
  // Without a stored id the provider falls back to customer_email.
  let stripeCustomerId: string | undefined
  if (input.provider === "STRIPE") {
    try {
      const existingUser = await db.user.findUnique({
        where: { id: actor.user.id },
        select: { stripeCustomerId: true },
      })
      stripeCustomerId = existingUser?.stripeCustomerId ?? undefined
      if (!stripeCustomerId) {
        stripeCustomerId = await createStripeCustomer({
          email: actor.user.email,
          name: actor.user.name ?? null,
        })
        try {
          await db.user.update({
            where: { id: actor.user.id },
            data: { stripeCustomerId },
          })
        } catch (err) {
          log.warn("Billing: failed to store Stripe customer id", {
            userId: actor.user.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.warn("Billing: Stripe customer lookup failed, continuing", {
        userId: actor.user.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // BIL-028: the attempt is recorded BEFORE the provider call, so
  // a checkout that dies at the provider still has a support
  // record (and the attempt id is the BIL-014 idempotency key).
  // Best-effort: a failed write never blocks checkout. Phase D:
  // priceAmount is the DISCOUNTED amount actually charged, plus
  // the normalised coupon code and discount (Stream A's columns).
  await recordCheckoutAttempt({
    attemptId,
    userId: actor.user.id,
    planVersionId: version.id,
    provider: input.provider,
    priceAmount: chargedAmount,
    priceCurrency: version.priceCurrency,
    couponCode: coupon
      ? (coupon.coupon.code ?? rawCouponCode?.toUpperCase() ?? null)
      : null,
    discountAmountMinor: coupon?.discountAmountMinor ?? null,
  })
  let result
  try {
    result = await createCheckoutForProvider(input.provider, {
      version: checkoutVersion,
      customer: {
        userId: actor.user.id,
        email: actor.user.email,
        name: actor.user.name,
      },
      successUrl,
      cancelUrl,
      // BIL-014: one id per checkout attempt — the client's on a retry,
      // else a fresh UUID — so the provider calls are idempotent.
      idempotencyKey: attemptId,
      stripeCustomerId,
      customerIpAddress: opts.clientIpAddress ?? null,
    })
  } catch (err) {
    await updateCheckoutAttempt(attemptId, { status: "FAILED" })
    throw err
  }
  await updateCheckoutAttempt(attemptId, {
    status: "COMPLETED",
    providerCheckoutId: result.providerCheckoutId ?? null,
  })
  // SRC-222: persist catalog ids the provider created, but only
  // where the version has none yet — a concurrent checkout that
  // created its own object first wins, and the next checkout
  // reuses it. Best-effort: a failed write never breaks checkout.
  // Phase D: NEVER persist when a coupon applied — the catalog
  // ids minted here price the DISCOUNTED amount, and persisting
  // one would make every later full-price checkout charge the
  // discounted price (or reuse a one-off discounted plan).
  if (result.catalog && !coupon) {
    const catalog = result.catalog
    try {
      if (catalog.stripePriceId) {
        await db.planVersion.updateMany({
          where: { id: version.id, stripePriceId: null },
          data: { stripePriceId: catalog.stripePriceId },
        })
      }
      if (catalog.paypalProductId) {
        await db.planVersion.updateMany({
          where: { id: version.id, paypalProductId: null },
          data: { paypalProductId: catalog.paypalProductId },
        })
      }
      if (catalog.paypalPlanId) {
        await db.planVersion.updateMany({
          where: { id: version.id, paypalPlanId: null },
          data: { paypalPlanId: catalog.paypalPlanId },
        })
      }
      if (catalog.polarProductId) {
        await db.planVersion.updateMany({
          where: { id: version.id, polarProductId: null },
          data: { polarProductId: catalog.polarProductId },
        })
      }
    } catch (err) {
      log.warn("Billing: failed to persist provider catalog ids", {
        planVersionId: version.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return {
    checkoutUrl: result.checkoutUrl,
    provider: input.provider,
    attemptId,
    providerCheckoutId: result.providerCheckoutId ?? null,
  }
}

// ─── Checkout attempts (BIL-028) ────────────────────────────────────────

// Best-effort by design: the attempt rows are support records, and
// a failed write must never block a checkout. A P2002 (the same
// attempt id retried — the client reuses it on double-submit,
// BIL-014) is the row already existing, not an error.
async function recordCheckoutAttempt(input: {
  attemptId: string
  userId: string
  planVersionId: string
  provider: BillingProvider
  priceAmount: number
  priceCurrency: string
  // Phase D (Coupons): the normalised code + the discount in minor
  // units, from the validated coupon. Null = no coupon on this
  // checkout. Stream A's nullable CheckoutAttempt columns.
  couponCode?: string | null
  discountAmountMinor?: number | null
}): Promise<void> {
  try {
    await db.checkoutAttempt.create({
      data: {
        ...input,
        status: "CREATED",
      },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // The row already exists (same attempt id retried — the
      // client reuses it on double-submit, BIL-014). A retry that
      // ADDS a coupon backfills the coupon fields onto the existing
      // row instead of dropping the code; a retry without one
      // leaves the row untouched. Best-effort throughout.
      if (input.couponCode != null || input.discountAmountMinor != null) {
        try {
          await db.checkoutAttempt.update({
            where: { attemptId: input.attemptId },
            data: {
              couponCode: input.couponCode ?? null,
              discountAmountMinor: input.discountAmountMinor ?? null,
            },
          })
        } catch (updateErr) {
          log.warn("Billing: failed to backfill coupon on retry attempt", {
            attemptId: input.attemptId,
            error:
              updateErr instanceof Error
                ? updateErr.message
                : String(updateErr),
          })
        }
      }
      return
    }
    log.warn("Billing: failed to record checkout attempt", {
      attemptId: input.attemptId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function updateCheckoutAttempt(
  attemptId: string,
  data: { status: "COMPLETED" | "FAILED"; providerCheckoutId?: string | null }
): Promise<void> {
  try {
    await db.checkoutAttempt.update({
      where: { attemptId },
      data: {
        status: data.status,
        ...(data.providerCheckoutId !== undefined
          ? { providerCheckoutId: data.providerCheckoutId }
          : {}),
      },
    })
  } catch (err) {
    log.warn("Billing: failed to update checkout attempt", {
      attemptId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// The admin list of checkout attempts: newest first, paginated,
// filterable by provider / user / status. The support view of "I
// paid but nothing happened" — the provider checkout id on the row
// is what a failed activation is reconciled against.
export async function listCheckoutAttempts(
  actor: AdminSession,
  filters: CheckoutAttemptsQuery
): Promise<{
  attempts: CheckoutAttemptRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  const where: Prisma.CheckoutAttemptWhereInput = {}
  if (filters.provider) where.provider = filters.provider
  if (filters.userId) where.userId = filters.userId
  if (filters.status) where.status = filters.status
  const [total, rows] = await Promise.all([
    db.checkoutAttempt.count({ where }),
    db.checkoutAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    attempts: rows.map((row) => ({
      id: row.id,
      attemptId: row.attemptId,
      userId: row.userId,
      planVersionId: row.planVersionId,
      provider: row.provider,
      providerCheckoutId: row.providerCheckoutId,
      priceAmount: row.priceAmount,
      priceCurrency: row.priceCurrency,
      status: row.status,
      createdAt: row.createdAt,
    })),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

// ─── Webhooks ─────────────────────────────────────────────────────────

// BIL-092 completion (Wave 6): attribute the webhook event to the
// customer it belongs to, so the customer payment-history view can be
// owner-scoped. Checkout-completed carries the buyer; renewals,
// failures, and cancels carry only the provider subscription id, so
// the user is resolved through the subscription row; ignored events
// carry no identity at all. Null when nothing resolves — the event
// is still recorded, it just belongs to no customer view.
async function resolveWebhookUserId(
  provider: BillingProvider,
  verified: VerifiedWebhook
): Promise<string | null> {
  // Attribution is best-effort: a failed lookup must NEVER stop the
  // webhook from being applied — the event is recorded unattributed
  // instead of being dropped or misreported as a duplicate.
  try {
    const event = verified.event
    if (event.kind === "checkout-completed") return event.userId
    if (event.kind === "ignored") return null
    if (event.kind === "freemius-checkout") {
      // SRC-207: the buyer is resolved HERE, in the service — never
      // in the provider adapter — and case-insensitively. A miss
      // returns null for attribution; the apply step throws 422 so
      // the paid event stays visible instead of silently ignored.
      const buyer = await db.user.findFirst({
        where: { email: event.buyerEmail.trim().toLowerCase() },
        select: { id: true },
      })
      return buyer?.id ?? null
    }
    if (event.kind === "payment-refunded") {
      if (event.providerSubscriptionId) {
        const subscription = await db.subscription.findFirst({
          where: {
            provider,
            providerSubscriptionId: event.providerSubscriptionId,
          },
          select: { userId: true },
          orderBy: { createdAt: "desc" },
        })
        if (subscription) return subscription.userId
      }
      if (event.providerReference) {
        const purchase = await db.oneTimePurchase.findFirst({
          where: {
            provider,
            providerReference: event.providerReference,
          },
          select: { userId: true },
          orderBy: { createdAt: "desc" },
        })
        return purchase?.userId ?? null
      }
      return null
    }
    if (event.kind === "unmapped-payment") {
      // BIL-100 / BIL-026: an unmapped payment has no subscription
      // to resolve from unless it carries a provider subscription
      // id — and a missing id must NEVER fall through to the
      // lookup below, where Prisma would ignore the undefined id
      // and match the provider's first subscription (the wrong
      // user). A renewal whose subscription IS known resolves to
      // that subscription's owner.
      if (event.providerSubscriptionId) {
        const subscription = await db.subscription.findFirst({
          where: {
            provider,
            providerSubscriptionId: event.providerSubscriptionId,
          },
          select: { userId: true },
          orderBy: { createdAt: "desc" },
        })
        return subscription?.userId ?? null
      }
      return null
    }
    const subscription = await db.subscription.findFirst({
      where: {
        provider,
        providerSubscriptionId: event.providerSubscriptionId,
      },
      select: { userId: true },
      orderBy: { createdAt: "desc" },
    })
    return subscription?.userId ?? null
  } catch (err) {
    log.warn("Billing webhook user attribution failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Verify the signature, skip already-processed event ids, then apply
// the event to subscriptions. `received` is true even for duplicates
// and ignored events — the provider still gets a 2xx so it stops
// retrying. A duplicate that arrives while the first delivery is
// still in flight is NOT applied twice: the create is guarded by the
// unique (provider, providerEventId) constraint.
//
// BIL-088: Freemius signs no timestamp, so a replay of an ALREADY
// APPLIED event (processedAt set) first seen longer than
// FREEMIUS_REPLAY_WINDOW_MS (10 min) ago is rejected outright with
// 409 — the provider retries a 409, and the event was already
// applied, so nothing is lost. The clock is the EARLIER of the
// row's createdAt (first receipt) and processedAt (apply time):
// in production the two are seconds apart, and the earlier one is
// the first-seen time the replay window is defined over. Inside
// the window the duplicate ack stands; a never-applied delivery
// (processedAt null) always goes through.
export async function handleWebhook(
  provider: BillingProvider,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<{ received: true; duplicate?: boolean; kind?: string }> {
  const verified = await verifyWebhookForProvider(provider, rawBody, headers)
  const existing = await db.billingEvent.findUnique({
    where: {
      provider_providerEventId: {
        provider,
        providerEventId: verified.eventId,
      },
    },
  })
  if (existing?.processedAt) {
    const firstSeenMs = Math.min(
      existing.createdAt.getTime(),
      existing.processedAt.getTime()
    )
    if (
      provider === "FREEMIUS" &&
      Date.now() - firstSeenMs > FREEMIUS_REPLAY_WINDOW_MS
    ) {
      throw new ApiError(
        "Replayed Freemius webhook rejected: event was already applied outside the replay window.",
        409
      )
    }
    return { received: true, duplicate: true, kind: verified.event.kind }
  }
  let eventRow = existing
  if (!eventRow) {
    try {
      eventRow = await db.billingEvent.create({
        data: {
          provider,
          providerEventId: verified.eventId,
          eventType: verified.eventType,
          // DB-015: the normalized kind — the closed set the
          // handler switches over and the admin list filters on.
          kind: billingEventKindFor(verified.event),
          userId: await resolveWebhookUserId(provider, verified),
        },
      })
    } catch (err) {
      // SRC-205: ONLY a P2002 means "lost a race with a concurrent
      // delivery of the same event" — the other delivery applies it
      // and this one only acknowledges. Any other error (DB outage,
      // validation) is rethrown so the provider retries: a bare
      // catch here used to ack a lost payment event as a duplicate
      // and stop retries entirely.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return { received: true, duplicate: true, kind: verified.event.kind }
      }
      throw err
    }
  } else if (!eventRow.userId) {
    // A duplicate that arrived while the first delivery was still in
    // flight: the row exists but was never attributed — fill the link
    // in now instead of leaving the event ownerless.
    const userId = await resolveWebhookUserId(provider, verified)
    if (userId) {
      eventRow = await db.billingEvent.update({
        where: { id: eventRow.id },
        data: { userId },
      })
    }
  }

  try {
    switch (verified.event.kind) {
      case "checkout-completed":
        await activateSubscriptionFromCheckout({
          userId: verified.event.userId,
          planVersionId: verified.event.planVersionId,
          provider,
          providerSubscriptionId: verified.event.providerSubscriptionId,
          periodEnd: verified.event.periodEnd,
          // BIL-003 / BIL-042: one-time checkouts carry no
          // subscription — the activation writes the separate
          // OneTimePurchase row with a finite access date.
          isOneTime: verified.event.isOneTime ?? false,
          providerReference: verified.event.providerReference,
          checkoutId: verified.event.checkoutId,
          // BIL-049 / BIL-096: a trial checkout activates as
          // TRIALING ending at the provider's trial end. Passed
          // only when present — the activation's exact-args
          // assertions (and the trialDays fallback) rely on the
          // key being absent otherwise.
          ...(verified.event.trialEnd
            ? { trialEnd: verified.event.trialEnd }
            : {}),
        })
        break
      case "freemius-checkout": {
        // SRC-207: the buyer is resolved here, in the service, by
        // lower-cased email. An unresolvable buyer is a VISIBLE
        // failure — the 422 leaves the BillingEvent row unprocessed
        // (admin-visible in the events list) instead of silently
        // dropping a paid order as "ignored".
        const buyer = await db.user.findFirst({
          where: { email: verified.event.buyerEmail.trim().toLowerCase() },
          select: { id: true },
        })
        if (!buyer) {
          throw new ApiError(
            `Freemius buyer ${verified.event.buyerEmail} has no SendCMS account — paid event left unprocessed for admin review.`,
            422
          )
        }
        await activateSubscriptionFromCheckout({
          userId: buyer.id,
          planVersionId: verified.event.planVersionId,
          provider,
          providerSubscriptionId: verified.event.providerSubscriptionId,
          periodEnd: verified.event.periodEnd,
          isOneTime: verified.event.isOneTime ?? false,
          providerReference: verified.event.providerReference,
          checkoutId: verified.event.checkoutId,
        })
        break
      }
      case "payment-succeeded": {
        // BIL-016: a renewal for a subscription SendCMS never
        // activated has nowhere to apply — the event is left
        // UNPROCESSED (no processedAt stamp) so the admin
        // unprocessed-events list is the reconciliation queue,
        // instead of being acked and forgotten.
        const applied = await extendSubscriptionPeriod(
          provider,
          verified.event.providerSubscriptionId,
          verified.event.periodEnd,
          // DB-010: the renewal is idempotent per webhook event —
          // a provider retry after a crash between apply and the
          // processedAt stamp no-ops instead of extending twice.
          verified.eventId
        )
        if (!applied) {
          log.warn(
            "Billing webhook renewal matched no subscription — left unprocessed",
            {
              provider,
              eventType: verified.eventType,
              providerSubscriptionId: verified.event.providerSubscriptionId,
            }
          )
          return { received: true, kind: verified.event.kind }
        }
        break
      }
      case "payment-failed": {
        // BIL-080: a failed renewal flips the subscription to PAST_DUE
        // with a grace window instead of being ignored. Same
        // no-match rule as payment-succeeded (BIL-016).
        const applied = await markSubscriptionPastDue(
          provider,
          verified.event.providerSubscriptionId
        )
        if (!applied) {
          log.warn(
            "Billing webhook payment failure matched no subscription — left unprocessed",
            {
              provider,
              eventType: verified.eventType,
              providerSubscriptionId: verified.event.providerSubscriptionId,
            }
          )
          return { received: true, kind: verified.event.kind }
        }
        break
      }
      case "subscription-canceled": {
        const applied = await cancelSubscriptionFromProvider(
          provider,
          verified.event.providerSubscriptionId,
          `Canceled by ${getBillingProviderDefinition(provider).label}`
        )
        if (!applied) {
          log.warn(
            "Billing webhook cancellation matched no subscription — left unprocessed",
            {
              provider,
              eventType: verified.eventType,
              providerSubscriptionId: verified.event.providerSubscriptionId,
            }
          )
          return { received: true, kind: verified.event.kind }
        }
        break
      }
      case "subscription-updated": {
        // BIL-005 / BIL-006 / BIL-045: provider-side changes sync
        // into SendCMS — period end, cancel-at-period-end, status,
        // and plan version — instead of being ignored. A plan
        // change re-points the subscription with a MIGRATED event
        // (Stream A's syncSubscriptionFromProvider, BIL-089
        // migration flow). No match → unprocessed (BIL-016).
        const applied = await syncSubscriptionFromProvider(
          provider,
          verified.event.providerSubscriptionId,
          {
            status: verified.event.status,
            periodEnd: verified.event.periodEnd,
            cancelAtPeriodEnd: verified.event.cancelAtPeriodEnd,
            planVersionId: verified.event.planVersionId,
          }
        )
        if (!applied) {
          log.warn(
            "Billing webhook subscription update matched no subscription — left unprocessed",
            {
              provider,
              eventType: verified.eventType,
              providerSubscriptionId: verified.event.providerSubscriptionId,
            }
          )
          return { received: true, kind: verified.event.kind }
        }
        break
      }
      case "payment-refunded": {
        // BIL-081 / BIL-004 / BIL-047 (owner decision 2026-11-25):
        // full refund → cancel; partial → keep + timeline entry.
        // An unmatched refund has nowhere to apply — it is logged
        // and the event row is still stamped processed (the provider
        // must not retry a refund SendCMS cannot match).
        const applied = await applyRefund(provider, {
          providerSubscriptionId: verified.event.providerSubscriptionId,
          providerReference: verified.event.providerReference,
          fullRefund: verified.event.fullRefund,
          amountMinor: verified.event.amountMinor,
        })
        if (!applied) {
          log.warn("Billing webhook refund matched no subscription", {
            provider,
            eventType: verified.eventType,
            providerSubscriptionId: verified.event.providerSubscriptionId,
            providerReference: verified.event.providerReference,
            fullRefund: verified.event.fullRefund,
          })
        }
        break
      }
      case "unmapped-payment":
        // BIL-100 / BIL-026 / BIL-016: a PAID event that cannot be
        // applied (missing metadata / no matching invoice line).
        // The provider gets a 200, but the event is deliberately
        // left UNPROCESSED — the admin unprocessed-events list is
        // the review queue, and reconcileCheckout is how a human
        // provisions it.
        log.warn("Billing webhook paid event could not be mapped", {
          provider,
          eventType: verified.eventType,
          providerCheckoutId: verified.event.providerCheckoutId ?? null,
          providerSubscriptionId: verified.event.providerSubscriptionId ?? null,
          reason: verified.event.reason,
        })
        return { received: true, kind: "unmapped-payment" }
      case "ignored":
        log.info("Billing webhook event ignored", {
          provider,
          eventType: verified.eventType,
        })
        break
      case "unmapped-payment":
        // BIL-100: a PAID checkout with no SendCMS metadata — the
        // customer paid and nothing can activate them. The
        // BillingEvent row is deliberately LEFT UNPROCESSED (no
        // processedAt stamp below): it stays visible in the admin
        // events list as an unprocessed payment for reconciliation.
        // The provider still gets a 2xx — retrying a payment that
        // cannot be auto-applied helps nobody; a human reconciles
        // it from the events list.
        log.warn("Billing webhook unmapped payment — left unprocessed", {
          provider,
          eventType: verified.eventType,
          providerCheckoutId: verified.event.providerCheckoutId,
          reason: verified.event.reason,
        })
        return { received: true, kind: verified.event.kind }
    }
  } catch (error) {
    log.error("Billing webhook event failed to apply", {
      provider,
      eventType: verified.eventType,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  await db.billingEvent.update({
    where: { id: eventRow.id },
    data: { processedAt: new Date() },
  })
  return { received: true, kind: verified.event.kind }
}

// ─── Checkout return verification + reconciliation (BIL-015/016/052) ─────

// Read-only: proves a checkout return against the provider instead
// of trusting the `checkout=success` query param. `verified` means
// paid AND the subscription row exists (ACTIVE/TRIALING) — the
// dashboard shows the success note only then. `pending` means paid
// but the row is missing — the webhook has not landed yet, so the
// dashboard shows "still activating" instead of a false success.
// Never throws for a provider miss — an unverifiable return is a
// `{verified:false}` result, not a 500.
export type CheckoutReturnVerification = {
  verified: boolean
  pending: boolean
  reason?: string
}

function paypalCustomId(resource: Record<string, unknown>): string | null {
  if (typeof resource.custom_id === "string") return resource.custom_id
  const units = resource.purchase_units
  if (Array.isArray(units) && units.length > 0) {
    const first = units[0] as Record<string, unknown>
    if (typeof first.custom_id === "string") return first.custom_id
    const payments = first.payments as Record<string, unknown> | undefined
    const captures = payments?.captures
    if (Array.isArray(captures) && captures.length > 0) {
      const capture = captures[0] as Record<string, unknown>
      if (typeof capture.custom_id === "string") {
        return capture.custom_id
      }
    }
  }
  return null
}

function paypalCaptureId(order: Record<string, unknown>): string | null {
  const units = order.purchase_units
  if (!Array.isArray(units) || units.length === 0) return null
  const first = units[0] as Record<string, unknown>
  const payments = first.payments as Record<string, unknown> | undefined
  const captures = payments?.captures
  if (!Array.isArray(captures) || captures.length === 0) return null
  const capture = captures[0] as Record<string, unknown>
  return typeof capture.id === "string" ? capture.id : null
}

async function findLiveSubscription(
  provider: BillingProvider,
  providerSubscriptionId: string
) {
  return db.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
      status: { in: ["ACTIVE", "TRIALING"] },
    },
    select: { id: true },
  })
}

export async function verifyCheckoutReturn(
  userId: string,
  provider: BillingProvider,
  checkoutId: string
): Promise<CheckoutReturnVerification> {
  if (provider === "STRIPE") {
    let session
    try {
      session = await retrieveStripeCheckoutSession(checkoutId)
    } catch (err) {
      return {
        verified: false,
        pending: false,
        reason: `Stripe session could not be read: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (session.metadata?.userId !== userId) {
      return {
        verified: false,
        pending: false,
        reason: "This checkout belongs to a different user.",
      }
    }
    if (session.payment_status !== "paid" || session.status !== "complete") {
      return {
        verified: false,
        pending: false,
        reason: "This checkout has not been paid.",
      }
    }
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : typeof session.subscription === "object" && session.subscription
          ? ((session.subscription as { id?: string }).id ?? null)
          : null
    const paymentIntent =
      typeof session.payment_intent === "string" ? session.payment_intent : null
    const providerSubscriptionId = subscriptionId ?? paymentIntent ?? session.id
    const row = await findLiveSubscription("STRIPE", providerSubscriptionId)
    if (row) return { verified: true, pending: false }
    return {
      verified: false,
      pending: true,
      reason:
        "Payment received — your subscription is still activating. If it doesn't appear shortly, contact support.",
    }
  }
  if (provider === "PAYPAL") {
    // A PayPal return carries a subscription id (I-...) or an order
    // id — try the subscription first, then the one-time order.
    let subscription: Record<string, unknown> | null = null
    try {
      subscription = await retrievePayPalSubscription(checkoutId)
    } catch {
      subscription = null
    }
    if (subscription) {
      const customId = paypalCustomId(subscription)
      const [customUserId] = customId ? customId.split(":") : []
      if (customUserId !== userId) {
        return {
          verified: false,
          pending: false,
          reason: "This checkout belongs to a different user.",
        }
      }
      if (subscription.status !== "ACTIVE") {
        return {
          verified: false,
          pending: false,
          reason: "This PayPal subscription is not active.",
        }
      }
      const row = await findLiveSubscription("PAYPAL", checkoutId)
      if (row) return { verified: true, pending: false }
      return {
        verified: false,
        pending: true,
        reason:
          "Payment received — your subscription is still activating. If it doesn't appear shortly, contact support.",
      }
    }
    let order: Record<string, unknown> | null = null
    try {
      order = await retrievePayPalOrder(checkoutId)
    } catch (err) {
      return {
        verified: false,
        pending: false,
        reason: `PayPal checkout could not be read: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!order) {
      return {
        verified: false,
        pending: false,
        reason: "PayPal checkout not found.",
      }
    }
    const customId = paypalCustomId(order)
    const [customUserId] = customId ? customId.split(":") : []
    if (customUserId !== userId) {
      return {
        verified: false,
        pending: false,
        reason: "This checkout belongs to a different user.",
      }
    }
    if (order.status !== "COMPLETED") {
      return {
        verified: false,
        pending: false,
        reason: "This PayPal order has not been paid.",
      }
    }
    const captureId = paypalCaptureId(order)
    const providerSubscriptionId = captureId ?? checkoutId
    const row = await findLiveSubscription("PAYPAL", providerSubscriptionId)
    if (row) return { verified: true, pending: false }
    return {
      verified: false,
      pending: true,
      reason:
        "Payment received — your subscription is still activating. If it doesn't appear shortly, contact support.",
    }
  }
  return {
    verified: false,
    pending: false,
    reason: "Checkout verification is not supported for this provider.",
  }
}

// BIL-016 / BIL-052: the explicit reconciliation path for a
// paid-but-unprovisioned checkout (the webhook was lost, or the
// event is sitting unprocessed in the admin queue). Re-reads the
// checkout from the provider, proves it was paid by THIS user,
// then activates through the same idempotent activation the
// webhook uses — a second call (or a late webhook) returns the
// existing subscription instead of a duplicate. Throws 422 when
// the checkout is unpaid, belongs to someone else, or carries no
// SendCMS plan; 403 when the caller is not the buyer.
export async function reconcileCheckout(
  userId: string,
  input: ReconcileCheckoutInput
) {
  if (input.provider === "STRIPE") {
    const session = await retrieveStripeCheckoutSession(
      input.providerCheckoutId
    )
    if (session.payment_status !== "paid" || session.status !== "complete") {
      throw new ApiError("This checkout has not been paid.", 422)
    }
    if (session.metadata?.userId !== userId) {
      throw new ApiError("This checkout belongs to a different user.", 403)
    }
    const planVersionId = session.metadata?.planVersionId
    if (!planVersionId) {
      throw new ApiError(
        "This checkout carries no SendCMS plan — it cannot be reconciled automatically. Contact support.",
        422
      )
    }
    const isOneTime =
      session.mode === "payment" || typeof session.subscription !== "string"
    const paymentIntent =
      typeof session.payment_intent === "string" ? session.payment_intent : null
    const providerSubscriptionId = isOneTime
      ? (paymentIntent ?? session.id)
      : (session.subscription as string)
    return activateSubscriptionFromCheckout({
      userId,
      planVersionId,
      provider: "STRIPE",
      providerSubscriptionId,
      periodEnd: null,
      isOneTime,
      providerReference: providerSubscriptionId,
      checkoutId: session.id,
    })
  }
  if (input.provider === "PAYPAL") {
    let subscription: Record<string, unknown> | null = null
    try {
      subscription = await retrievePayPalSubscription(input.providerCheckoutId)
    } catch {
      subscription = null
    }
    if (subscription) {
      const customId = paypalCustomId(subscription)
      const [customUserId, planVersionId] = customId ? customId.split(":") : []
      if (!customUserId || !planVersionId) {
        throw new ApiError(
          "This PayPal subscription carries no SendCMS plan — it cannot be reconciled automatically. Contact support.",
          422
        )
      }
      if (customUserId !== userId) {
        throw new ApiError("This checkout belongs to a different user.", 403)
      }
      if (subscription.status !== "ACTIVE") {
        throw new ApiError("This PayPal subscription is not active.", 422)
      }
      const billingInfo = subscription.billing_info as
        Record<string, unknown> | undefined
      const nextBilling =
        typeof billingInfo?.next_billing_time === "string"
          ? new Date(billingInfo.next_billing_time)
          : null
      return activateSubscriptionFromCheckout({
        userId,
        planVersionId,
        provider: "PAYPAL",
        providerSubscriptionId: input.providerCheckoutId,
        periodEnd:
          nextBilling && !Number.isNaN(nextBilling.getTime())
            ? nextBilling
            : null,
      })
    }
    const order = await retrievePayPalOrder(input.providerCheckoutId)
    const customId = paypalCustomId(order)
    const [customUserId, planVersionId] = customId ? customId.split(":") : []
    if (!customUserId || !planVersionId) {
      throw new ApiError(
        "This PayPal order carries no SendCMS plan — it cannot be reconciled automatically. Contact support.",
        422
      )
    }
    if (customUserId !== userId) {
      throw new ApiError("This checkout belongs to a different user.", 403)
    }
    if (order.status !== "COMPLETED") {
      throw new ApiError("This PayPal order has not been paid.", 422)
    }
    const captureId = paypalCaptureId(order)
    const providerSubscriptionId = captureId ?? input.providerCheckoutId
    return activateSubscriptionFromCheckout({
      userId,
      planVersionId,
      provider: "PAYPAL",
      providerSubscriptionId,
      periodEnd: null,
      isOneTime: true,
      providerReference: providerSubscriptionId,
      checkoutId: input.providerCheckoutId,
    })
  }
  throw new ApiError(
    `Reconciliation is not supported for ${input.provider}. Contact support with the checkout id.`,
    422
  )
}

// BIL-017: a Billing Portal session for the signed-in user, so they
// can manage payment methods and cancel at Stripe. Requires a
// stored Stripe Customer id — a user who has never paid through
// Stripe has nothing to manage at Stripe yet.
export async function createBillingPortalSession(
  userId: string
): Promise<{ url: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  })
  if (!user?.stripeCustomerId) {
    throw new ApiError(
      "No Stripe customer exists for this user yet — the Billing Portal is available after your first Stripe payment.",
      422
    )
  }
  const dashboardUrl = dashboardBaseUrl()
  const url = await createStripeBillingPortalSession(
    user.stripeCustomerId,
    `${dashboardUrl}/dashboard/billing`
  )
  return { url }
}
