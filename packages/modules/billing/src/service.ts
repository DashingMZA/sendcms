import { randomUUID } from "node:crypto"
import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  db,
  type BillingProvider,
  type Prisma,
} from "@sendcms/database"
import { requireAdmin, type PlatformCapability } from "@sendcms/permissions"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import {
  activateSubscriptionFromCheckout,
  cancelSubscriptionFromProvider,
  extendSubscriptionPeriod,
  markSubscriptionPastDue,
} from "@sendcms/plans"
import {
  BILLING_PROVIDERS,
  getBillingProviderDefinition,
  isProviderConfigured,
  missingEnvVars,
} from "./registry"
import {
  createCheckoutForProvider,
  getFreemiusPlanMapCount,
  verifyWebhookForProvider,
} from "./providers"
import type { PlanVersionForCheckout, VerifiedWebhook } from "./providers/types"
import type {
  BillingEventsQuery,
  CheckoutSessionInput,
  SetProviderConfigInput,
} from "./validators"

const log = createLogger("billing")

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
}

// Start a hosted checkout for the signed-in user. The plan version is
// re-read from the DB (never trusted from the client), free plans
// refuse with 422 (no payment needed), and the provider must be
// enabled + configured + available in the customer's country.
export async function createCheckoutSession(
  actor: AdminSession,
  input: CheckoutSessionInput
): Promise<{
  checkoutUrl: string
  provider: BillingProvider
  // BIL-014: the attempt id the provider calls were keyed on — the
  // client reuses it when retrying a double-submit.
  attemptId: string
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
  await requireProviderAvailable(input.provider, input.countryCode)

  const dashboardUrl = (
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  ).replace(/\/+$/, "")
  const successUrl = `${dashboardUrl}/dashboard/billing?checkout=success&provider=${input.provider.toLowerCase()}`
  const cancelUrl = `${dashboardUrl}/dashboard/billing/checkout?planVersionId=${version.id}&cancelled=1`
  const checkoutVersion: PlanVersionForCheckout = {
    id: version.id,
    planId: version.planId,
    planName: version.plan.name,
    priceAmount: version.priceAmount,
    priceCurrency: version.priceCurrency,
    billingInterval: version.billingInterval,
    trialDays: version.trialDays,
  }
  const attemptId = input.attemptId ?? randomUUID()
  const result = await createCheckoutForProvider(input.provider, {
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
  })
  return {
    checkoutUrl: result.checkoutUrl,
    provider: input.provider,
    attemptId,
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
          userId: await resolveWebhookUserId(provider, verified),
        },
      })
    } catch {
      // Lost a race with a concurrent delivery of the same event —
      // the other delivery applies it; this one only acknowledges.
      return { received: true, duplicate: true, kind: verified.event.kind }
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
        })
        break
      case "payment-succeeded":
        await extendSubscriptionPeriod(
          provider,
          verified.event.providerSubscriptionId,
          verified.event.periodEnd
        )
        break
      case "payment-failed":
        // BIL-080: a failed renewal flips the subscription to PAST_DUE
        // with a grace window instead of being ignored.
        await markSubscriptionPastDue(
          provider,
          verified.event.providerSubscriptionId
        )
        break
      case "subscription-canceled":
        await cancelSubscriptionFromProvider(
          provider,
          verified.event.providerSubscriptionId,
          `Canceled by ${getBillingProviderDefinition(provider).label}`
        )
        break
      case "ignored":
        log.info("Billing webhook event ignored", {
          provider,
          eventType: verified.eventType,
        })
        break
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
