import { randomUUID } from "node:crypto"
import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditResource,
  db,
  type AdminRole,
  type BillingProvider,
  type PlatformRole,
} from "@sendcms/database"
import { adminCan, type PlatformCapability } from "@sendcms/permissions"
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
  verifyWebhookForProvider,
} from "./providers"
import type { PlanVersionForCheckout } from "./providers/types"
import type { CheckoutSessionInput, SetProviderConfigInput } from "./validators"

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
//   friends, Gumroad PK) are admin choices, never hardcoded here.
// - Webhook events are idempotent on (provider, providerEventId):
//   an already-processed event id is skipped, never applied twice.
// - Never trust client-supplied plan/price: the checkout re-reads
//   the plan version from the DB, and the webhook re-reads it too
//   (via the activation function), so a tampered request cannot buy
//   a cheaper plan or activate a different one.

// ─── Authorization ────────────────────────────────────────────────────

function getEffectiveRole(session: AdminSession): PlatformRole | AdminRole {
  if (session.user.platformRole === "PLATFORM_OWNER") return "PLATFORM_OWNER"
  return session.user.adminRole ?? "PLATFORM_USER"
}

export function requireBillingAdmin(
  session: AdminSession,
  capability: PlatformCapability
): void {
  if (!adminCan(getEffectiveRole(session), capability)) {
    throw new ApiError(
      "Forbidden: you do not have permission for this admin action.",
      403
    )
  }
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
  }
}

// ─── Admin: provider configs ──────────────────────────────────────────

// List all five provider configs, creating the rows on first use.
// Booleans ONLY for env presence — never the values.
export async function listProviderConfigs(
  actor: AdminSession
): Promise<BillingProviderConfigRow[]> {
  requireBillingAdmin(actor, "VIEW_BILLING")
  for (const definition of BILLING_PROVIDERS) {
    await db.billingProviderConfig.upsert({
      where: { provider: definition.id },
      update: {},
      create: { provider: definition.id },
    })
  }
  const configs = await db.billingProviderConfig.findMany({
    include: { countries: { select: { countryCode: true } } },
    orderBy: { provider: "asc" },
  })
  // Present in the user-approved provider order, not enum order.
  const byId = new Map(configs.map((c) => [c.provider, c]))
  return BILLING_PROVIDERS.map((definition) =>
    toConfigRow(byId.get(definition.id)!)
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
    },
  })
  return newRow
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
      "This plan is free and needs no payment — subscribe from the plan page instead.",
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
        },
      })
    } catch {
      // Lost a race with a concurrent delivery of the same event —
      // the other delivery applies it; this one only acknowledges.
      return { received: true, duplicate: true, kind: verified.event.kind }
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
