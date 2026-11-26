import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, Prisma, db } from "@sendcms/database"
import type {
  BillingInterval,
  BillingProvider,
  Plan,
  PlanKind,
  PlanStatus,
  PlanVersion,
  PlanVersionStatus,
  SubscriptionEventType,
  SubscriptionStatus,
  UsageMeter,
} from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import { requireAdmin } from "@sendcms/permissions"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import {
  FREE_PLAN_V1_ENTITLEMENTS,
  PlanEntitlementsSchema,
  type PlanEntitlements,
} from "./validators"
import type {
  AssignSubscriptionInput,
  CancelSubscriptionInput,
  CreatePlanInput,
  CreatePlanVersionInput,
  DuplicatePlanInput,
  EntitlementOverrideListQuery,
  ExecuteMigrationInput,
  MigrationPreviewInput,
  PlanListQuery,
  PublishPlanVersionInput,
  RecordUsageInput,
  SetEntitlementOverrideInput,
  SubscribeFreePlanInput,
  SubscriptionListQuery,
} from "./validators"

const logger = createLogger("plans")

// Plans & entitlements (Phase 4) — versioned plans, subscriptions,
// entitlement resolution, usage metering, per-user overrides.
// Framework-independent (no Next.js imports); only services import
// @sendcms/database.
//
// Authorization lives HERE, not in the routes: every function takes the
// actor's AdminSession first and enforces its capability before touching
// any data. The UI is never the security boundary.
//
// The core invariant: a PUBLISHED plan version is never mutated. Editing
// a plan's price, limits, AI or MCP config creates a NEW version; a
// subscription keeps pointing at the version it was assigned (its
// EFFECTIVE version) until an explicit, audited migration moves it.

// ─── Authorization ────────────────────────────────────────────────────

// The admin gate lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module, re-exported
// here so existing import paths keep working.
export { getEffectiveRole, requireAdmin } from "@sendcms/permissions"

// ─── Platform config (emergency switch) ───────────────────────────────

// Precedence level 1 in entitlement resolution. The flag lives in the
// workspace-root `config/config.json` (the repo's feature-flag file —
// see AGENTS.md: "All new config goes here, not .env or hardcoded"):
//
//   { "platform": { "emergency": false } }
//
// When `emergency` is on, AI + MCP are denied for everyone (forms,
// domains and submissions keep working — the emergency switch must
// never disable form submission, inbox, or non-AI services). Default
// is OFF: a missing file, bad JSON, or missing key all mean "no
// emergency". The value is cached per process; tests reset it with
// `resetPlatformConfigCache()`. This is the ONLY config source for the
// flag — no env var, no second file.
export type PlatformConfig = { emergency: boolean }

let platformConfigCache: PlatformConfig | null = null

export function resetPlatformConfigCache(): void {
  platformConfigCache = null
}

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// Directory of this module file. The workspace root is resolved from
// here as well as from process.cwd() (DOC-018): in a deployed server
// the working directory is the app directory, not the workspace root,
// so the pnpm-workspace.yaml marker is not discoverable from cwd and
// the old reader silently fell back to "no emergency" — the kill-switch
// could be inert in production with no error or log. Resolving from
// the module file keeps the configured flag in effect wherever the
// process starts.
const moduleDir = dirname(fileURLToPath(import.meta.url))

// Resolves config/config.json, preferring the workspace root found
// from the working directory and falling back to the root found from
// this module file's location. Returns the resolved path and whether
// the module-file fallback was used, or null when neither walk finds
// the workspace marker or the config file.
function resolveConfigPath(): {
  path: string
  viaModuleFile: boolean
} | null {
  for (const [startDir, viaModuleFile] of [
    [process.cwd(), false],
    [moduleDir, true],
  ] as const) {
    const root = findWorkspaceRoot(startDir)
    if (!root) continue
    const path = join(root, "config", "config.json")
    if (existsSync(path)) return { path, viaModuleFile }
  }
  return null
}

export function readPlatformConfig(): PlatformConfig {
  if (platformConfigCache) return platformConfigCache
  let emergency = false
  const resolved = resolveConfigPath()
  if (!resolved) {
    // Loud fallback (DOC-018): the emergency kill-switch is running
    // on its default (OFF) because config/config.json could not be
    // found from either the working directory or this package's
    // location. Fail-open is deliberate — a missing file must never
    // disable form submission — but the operator must see that the
    // configured flag is not in effect.
    logger.warn(
      "config/config.json not found; emergency switch defaulting to OFF",
      {
        cwd: process.cwd(),
        defaults: { emergency: false },
      }
    )
  } else {
    if (resolved.viaModuleFile) {
      logger.warn(
        "config/config.json not found from working directory; resolved relative to package file",
        { cwd: process.cwd(), configPath: resolved.path }
      )
    }
    try {
      const raw = readFileSync(resolved.path, "utf8")
      const parsed = JSON.parse(raw) as {
        platform?: { emergency?: unknown }
      }
      emergency = parsed.platform?.emergency === true
    } catch {
      logger.warn(
        "config/config.json unreadable; emergency switch defaulting to OFF",
        { configPath: resolved.path, defaults: { emergency: false } }
      )
      emergency = false
    }
  }
  platformConfigCache = { emergency }
  return platformConfigCache
}

// ─── Entitlements parsing ─────────────────────────────────────────────

// PlanVersion.entitlements is Json in the DB; the Zod schema is the
// single source of truth for its shape. Parse at the boundary (write
// and read). A stored version that fails validation is corrupt data —
// fail loudly (500) rather than silently enforcing wrong limits.
function parseEntitlements(value: unknown): PlanEntitlements {
  const parsed = PlanEntitlementsSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError("Stored plan entitlements are invalid.", 500)
  }
  return parsed.data
}

function parseEntitlementsInput(value: unknown): PlanEntitlements {
  const parsed = PlanEntitlementsSchema.safeParse(value)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const messages = [
      ...flat.formErrors,
      ...Object.values(flat.fieldErrors).flat(),
    ].filter(Boolean)
    throw new ApiError(
      `Invalid entitlements: ${messages.join("; ") || "validation failed"}`,
      400
    )
  }
  return parsed.data
}

// ─── Period buckets ───────────────────────────────────────────────────

// UTC midnight starting the day `at` falls on.
export function startOfUtcDay(at: Date = new Date()): Date {
  const day = new Date(at)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

// UTC midnight starting the calendar month `at` falls in.
export function startOfUtcMonth(at: Date = new Date()): Date {
  const month = new Date(at)
  month.setUTCDate(1)
  month.setUTCHours(0, 0, 0, 0)
  return month
}

// UTC midnight starting the hour `at` falls in.
export function startOfUtcHour(at: Date = new Date()): Date {
  const hour = new Date(at)
  hour.setUTCMinutes(0, 0, 0)
  return hour
}

// The ledger bucket start for a meter: monthly meters bucket by month,
// daily meters by day, hourly meters by hour; count meters (forms /
// domains / API keys) have no time window — their ledger rows bucket by
// month for reporting.
function periodStartForMeter(meter: UsageMeter, at: Date = new Date()): Date {
  if (meter === "AI_REQUESTS") return startOfUtcDay(at)
  if (meter === "MCP_REQUESTS") return startOfUtcHour(at)
  return startOfUtcMonth(at)
}

// ─── Shapes ───────────────────────────────────────────────────────────

export const FREE_PLAN_SLUG = "free"

export type PlanVersionIdentity = {
  id: string
  planId: string
  planName: string
  version: number
  priceAmount: number | null
  priceCurrency: string
  billingInterval: BillingInterval
  trialDays: number
}

export type PlanVersionSummary = PlanVersionIdentity & {
  status: PlanVersionStatus
  entitlements: PlanEntitlements
  changeReason: string | null
  publishedAt: Date | null
  createdById: string | null
  createdAt: Date
}

export type PlanSummary = {
  id: string
  name: string
  slug: string
  description: string | null
  kind: PlanKind
  isPrivate: boolean
  status: PlanStatus
  currentVersion: {
    id: string
    version: number
    priceAmount: number | null
    priceCurrency: string
    billingInterval: BillingInterval
  } | null
  versionCount: number
  subscriptionCount: number
  createdAt: Date
  updatedAt: Date
}

export type PlanDetail = PlanSummary & {
  versions: PlanVersionSummary[]
}

export type SubscriptionEventSummary = {
  id: string
  type: SubscriptionEventType
  fromPlanVersion: { id: string; version: number } | null
  toPlanVersion: { id: string; version: number } | null
  adminId: string | null
  admin: { id: string; name: string | null; email: string } | null
  reason: string | null
  createdAt: Date
}

export type SubscriptionSummary = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string }
  planId: string
  plan: { id: string; name: string; slug: string }
  planVersionId: string
  planVersion: PlanVersionIdentity
  status: SubscriptionStatus
  provider: BillingProvider | null
  providerSubscriptionId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

export type SubscriptionDetail = SubscriptionSummary & {
  events: SubscriptionEventSummary[]
}

// The entitlement key each meter's limit lives under. MCP_REQUESTS maps
// to the HOURLY limit: the per-minute limit is enforced per API key in
// the MCP rate limiter, while the hourly limit is the user-level
// aggregate the admin UI and checkLimit report on.
const METER_LIMIT_KEY = {
  FORMS: "forms",
  DOMAINS: "domains",
  SUBMISSIONS: "submissionsPerMonth",
  API_KEYS: "apiKeys",
  MCP_REQUESTS: "mcpRequestsPerHour",
  AI_REQUESTS: "aiRequestsPerDay",
} as const

export type EffectiveEntitlements = {
  // null only when the user is denied entirely (suspended/disabled).
  entitlements: PlanEntitlements | null
  source: "override" | "subscription" | "free"
  planVersionId: string | null
  denied?: string
  // True while the platform emergency switch is on (AI + MCP zeroed).
  emergency: boolean
  overriddenMeters: UsageMeter[]
}

export type LimitCheck = {
  allowed: boolean
  limit: number | null
  used: number
  remaining: number | null
}

export type UsageRow = {
  id: string
  userId: string
  meter: UsageMeter
  quantity: number
  unit: string
  period: Date
  sourceEvent: string | null
  idempotencyKey: string
  resourceId: string | null
  createdAt: Date
}

export type EntitlementOverrideRow = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string }
  meter: UsageMeter
  value: number | null
  reason: string
  adminId: string | null
  admin: { id: string; name: string | null; email: string } | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type VersionDiffChange = {
  field: string
  label: string
  from: unknown
  to: unknown
}

export type VersionDiff = {
  from: PlanVersionIdentity
  to: PlanVersionIdentity
  changes: VersionDiffChange[]
}

export type MigrationPreviewUser = {
  userId: string
  email: string
  name: string | null
  fromVersion: { id: string; version: number; planName: string } | null
  toVersion: { id: string; version: number; planName: string }
  priceChange: { from: number | null; to: number | null; currency: string }
  limitsChange: VersionDiffChange[]
}

export type MigrationPreview = {
  targetPlanVersionId: string
  targetPlan: { id: string; name: string; slug: string }
  affectedCount: number
  // The first 100 affected users; `previewTruncated` says whether more
  // exist (the full set still migrates — the preview is only a window).
  users: MigrationPreviewUser[]
  previewTruncated: boolean
  skippedUserIds: string[]
  // BIL-089: whether executing this migration also changes what the
  // provider bills. `billingUnchanged` is true when at least one
  // affected subscription is billed by a provider with no
  // plan-change API (Freemius, Gumroad) or has no provider at all —
  // the preview says so plainly instead of implying a price change
  // that will never be charged.
  billingUnchanged: boolean
  providerUpdateSupported: boolean
  providerUpdateNote?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────

function toPlanVersionIdentity(
  version: PlanVersion & { plan: { name: string } }
): PlanVersionIdentity {
  return {
    id: version.id,
    planId: version.planId,
    planName: version.plan.name,
    version: version.version,
    priceAmount: version.priceAmount,
    priceCurrency: version.priceCurrency,
    billingInterval: version.billingInterval,
    trialDays: version.trialDays,
  }
}

function toPlanVersionSummary(
  version: PlanVersion & { plan: { name: string } }
): PlanVersionSummary {
  return {
    ...toPlanVersionIdentity(version),
    status: version.status,
    entitlements: parseEntitlements(version.entitlements),
    changeReason: version.changeReason,
    publishedAt: version.publishedAt,
    createdById: version.createdById,
    createdAt: version.createdAt,
  }
}

function toPlanSummary(
  row: Plan & {
    currentVersion: {
      id: string
      version: number
      priceAmount: number | null
      priceCurrency: string
      billingInterval: BillingInterval
    } | null
    _count: { versions: number; subscriptions: number }
  }
): PlanSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: row.kind,
    isPrivate: row.isPrivate,
    status: row.status,
    currentVersion: row.currentVersion,
    versionCount: row._count.versions,
    subscriptionCount: row._count.subscriptions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSubscriptionSummary(
  row: SubscriptionWithRelations
): SubscriptionSummary {
  return {
    id: row.id,
    userId: row.userId,
    user: row.user,
    planId: row.planId,
    plan: row.plan,
    planVersionId: row.planVersionId,
    planVersion: toPlanVersionIdentity(row.planVersion),
    status: row.status,
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type SubscriptionWithRelations = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string }
  planId: string
  plan: { id: string; name: string; slug: string }
  planVersionId: string
  planVersion: PlanVersion & { plan: { name: string } }
  status: SubscriptionStatus
  provider: BillingProvider | null
  providerSubscriptionId: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

const subscriptionInclude = {
  user: { select: { id: true, name: true, email: true } },
  plan: { select: { id: true, name: true, slug: true } },
  planVersion: { include: { plan: { select: { name: true } } } },
} as const

// The next version number for a plan (max + 1). The @@unique([planId,
// version]) constraint is the backstop against a concurrent duplicate.
async function nextVersionNumber(planId: string): Promise<number> {
  const latest = await db.planVersion.findFirst({
    where: { planId },
    orderBy: { version: "desc" },
    select: { version: true },
  })
  return (latest?.version ?? 0) + 1
}

// SRC-206 / DB-028: the version number is max + 1 computed outside
// the insert, so two concurrent version creates can both compute N+1
// — the loser gets P2002 on @@unique([planId, version]). The number
// is system-computed, not user input, so a duplicate is not a client
// error: retry with a freshly computed number. Bounded at three
// attempts; a third collision is a 409 asking for a retry.
async function createPlanVersionWithRetry(
  planId: string,
  buildData: () => Omit<Prisma.PlanVersionUncheckedCreateInput, "version">
): Promise<PlanVersion> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.planVersion.create({
        data: {
          ...buildData(),
          version: await nextVersionNumber(planId),
        },
      })
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        if (attempt < 2) continue
        throw new ApiError(
          "Another plan version was created at the same time. Please try again.",
          409
        )
      }
      throw err
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new ApiError(
    "Could not create the plan version. Please try again.",
    409
  )
}

async function getPlanOrThrow(planId: string) {
  const plan = await db.plan.findUnique({
    where: { id: planId },
    include: {
      currentVersion: true,
      _count: { select: { versions: true, subscriptions: true } },
    },
  })
  if (!plan) throw new ApiError("Plan not found", 404)
  return plan
}

async function getVersionOrThrow(versionId: string) {
  const version = await db.planVersion.findUnique({
    where: { id: versionId },
    include: { plan: { select: { name: true } } },
  })
  if (!version) throw new ApiError("Plan version not found", 404)
  return version
}

// The next period end for a billing interval. CUSTOM and ONE_TIME
// have no automatic period (the admin sets dates, or none).
// BIL-099: month/year arithmetic CLAMPS to the target month's last
// day — the naive `setUTCMonth` overflows (31 Jan + 1 month used
// to yield 3 Mar, not 28 Feb) and the drift compounded on every
// renewal. 29 Feb + 1 year clamps to 28 Feb in non-leap years.
export function periodEndFor(
  interval: BillingInterval,
  start: Date
): Date | null {
  if (interval === "MONTHLY") {
    return addMonthsClamped(start, 1)
  }
  if (interval === "ANNUAL") {
    return addYearsClamped(start, 1)
  }
  return null
}

// Add months, clamping the day to the target month's last day
// (31 Jan + 1 mo -> 28 Feb, never 3 Mar). Time-of-day is preserved.
export function addMonthsClamped(start: Date, months: number): Date {
  const targetMonth = start.getUTCMonth() + months
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12)
  const month = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()
  const end = new Date(start)
  end.setUTCFullYear(targetYear, month, Math.min(start.getUTCDate(), lastDay))
  return end
}

// Add years, clamping 29 Feb to 28 Feb in non-leap years.
export function addYearsClamped(start: Date, years: number): Date {
  const targetYear = start.getUTCFullYear() + years
  const lastDay = new Date(
    Date.UTC(targetYear, start.getUTCMonth() + 1, 0)
  ).getUTCDate()
  const end = new Date(start)
  end.setUTCFullYear(
    targetYear,
    start.getUTCMonth(),
    Math.min(start.getUTCDate(), lastDay)
  )
  return end
}

// BIL-003 (owner decision 2026-11-25): a one-time purchase grants
// access for a FINITE window — one year from purchase when the
// provider gives no end date. This is a documented default, not a
// lifetime flag (there is deliberately no lifetime flag anywhere):
// a one-time payment buys a year of the plan, then the subscription
// expires via the expiry job unless renewed by a new purchase.
export const ONE_TIME_ACCESS_DAYS = 365

export function oneTimeAccessEnd(start: Date): Date {
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + ONE_TIME_ACCESS_DAYS)
  return end
}

// BIL-001 / BIL-082: the provider-cancel callback the cancel
// functions take. It lives in @sendcms/billing (the provider
// modules), NOT here — @sendcms/billing already depends on
// @sendcms/plans, so importing it here would be a cycle. The
// routes pass the real implementation in; a caller that passes
// none gets a 502 when a provider-billed row is canceled, never a
// silent local-only cancel. The signature mirrors
// `cancelSubscriptionAtProvider` in @sendcms/billing exactly
// (provider first, then the cancel args), so the dispatcher can be
// passed in directly.
export type ProviderCancelOutcome = {
  canceledAtProvider: boolean
  immediate: boolean
  note?: string
}
export type ProviderCancelFn = (
  provider: BillingProvider,
  args: {
    providerSubscriptionId: string
    cancelAtPeriodEnd: boolean
    reason?: string | null
  }
) => Promise<ProviderCancelOutcome>

// BIL-089: the provider plan-change callback the migration takes
// (same layering reason as ProviderCancelFn). The signature mirrors
// `updateSubscriptionAtProvider` in @sendcms/billing exactly —
// provider, provider subscription id, then the checkout args for
// the TARGET version (built by executeMigration from the target
// version + the user's email/name). `updated: false` means the
// provider has no plan-change API — the migration proceeds as an
// explicitly SendCMS-only change.
export type ProviderUpdateOutcome = {
  updated: boolean
  reason?: string
}
export type ProviderUpdateFn = (
  provider: BillingProvider,
  providerSubscriptionId: string,
  args: {
    version: {
      id: string
      planId: string
      planName: string
      priceAmount: number | null
      priceCurrency: string
      billingInterval: BillingInterval
      trialDays: number
    }
    customer: { userId: string; email: string; name: string | null }
    successUrl: string
    cancelUrl: string
    idempotencyKey?: string
  }
) => Promise<ProviderUpdateOutcome>

export type OneTimePurchaseSummary = {
  id: string
  userId: string
  planId: string
  planVersionId: string
  subscriptionId: string | null
  provider: BillingProvider
  providerReference: string
  checkoutId: string | null
  priceAmount: number | null
  priceCurrency: string
  accessStart: Date
  accessEnd: Date
  status: "ACTIVE" | "REFUNDED" | "EXPIRED"
  createdAt: Date
  updatedAt: Date
}

// Human labels for the version-diff fields.
const DIFF_LABELS: Record<string, string> = {
  priceAmount: "Price",
  priceCurrency: "Currency",
  billingInterval: "Billing interval",
  trialDays: "Trial days",
  forms: "Forms limit",
  domains: "Domains limit",
  submissionsPerMonth: "Submissions / month",
  apiKeys: "API keys limit",
  aiRequestsPerDay: "AI requests / day",
  mcpRequestsPerMinute: "MCP requests / minute",
  mcpRequestsPerHour: "MCP requests / hour",
  aiProviders: "AI providers",
  aiByokAllowed: "BYOK allowed",
  aiPlatformAllowed: "Platform AI allowed",
  features: "Features",
}

function diffValues(
  from: PlanVersionIdentity & { entitlements: PlanEntitlements },
  to: PlanVersionIdentity & { entitlements: PlanEntitlements }
): VersionDiffChange[] {
  const changes: VersionDiffChange[] = []
  const push = (field: string, fromValue: unknown, toValue: unknown) => {
    if (JSON.stringify(fromValue) !== JSON.stringify(toValue)) {
      changes.push({
        field,
        label: DIFF_LABELS[field] ?? field,
        from: fromValue,
        to: toValue,
      })
    }
  }
  push("priceAmount", from.priceAmount, to.priceAmount)
  push("priceCurrency", from.priceCurrency, to.priceCurrency)
  push("billingInterval", from.billingInterval, to.billingInterval)
  push("trialDays", from.trialDays, to.trialDays)
  for (const key of [
    "forms",
    "domains",
    "submissionsPerMonth",
    "apiKeys",
    "aiRequestsPerDay",
    "mcpRequestsPerMinute",
    "mcpRequestsPerHour",
    "aiProviders",
    "aiByokAllowed",
    "aiPlatformAllowed",
    "features",
  ] as const) {
    push(key, from.entitlements[key], to.entitlements[key])
  }
  return changes
}

// ─── Plans ────────────────────────────────────────────────────────────

export async function listPlans(
  actor: AdminSession,
  filters: PlanListQuery
): Promise<{
  plans: PlanSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_PLAN_VERSIONS")
  const { q, slug, status, kind, page, perPage, sort } = filters
  const where: Prisma.PlanWhereInput = {}
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
    ]
  }
  if (slug) where.slug = slug
  if (status) where.status = status
  if (kind) where.kind = kind
  const [field = "createdAt", direction = "desc"] = sort.split(":")
  const orderBy: Prisma.PlanOrderByWithRelationInput = {
    [field]: direction === "asc" ? "asc" : "desc",
  }
  const [total, rows] = await Promise.all([
    db.plan.count({ where }),
    db.plan.findMany({
      where,
      include: {
        currentVersion: {
          select: {
            id: true,
            version: true,
            priceAmount: true,
            priceCurrency: true,
            billingInterval: true,
          },
        },
        _count: { select: { versions: true, subscriptions: true } },
      },
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    plans: rows.map(toPlanSummary),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

export async function getPlan(
  actor: AdminSession,
  planId: string
): Promise<PlanDetail> {
  requireAdmin(actor, "VIEW_PLAN_VERSIONS")
  const plan = await getPlanOrThrow(planId)
  const versions = await db.planVersion.findMany({
    where: { planId },
    include: { plan: { select: { name: true } } },
    orderBy: { version: "desc" },
  })
  return {
    ...toPlanSummary(plan),
    versions: versions.map(toPlanVersionSummary),
  }
}

export async function getPlanVersion(
  actor: AdminSession,
  versionId: string
): Promise<PlanVersionSummary> {
  requireAdmin(actor, "VIEW_PLAN_VERSIONS")
  return toPlanVersionSummary(await getVersionOrThrow(versionId))
}

// Creating a plan creates version 1 as a DRAFT with the given
// entitlements + price. The plan becomes visible to subscribers only
// when a version is published.
export async function createPlan(
  actor: AdminSession,
  input: CreatePlanInput
): Promise<PlanDetail> {
  requireAdmin(actor, "MANAGE_PLANS")
  const entitlements = parseEntitlementsInput(input.entitlements)
  try {
    const plan = await db.$transaction(async (tx) => {
      const created = await tx.plan.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          kind: input.kind,
          isPrivate: input.isPrivate,
          status: "DRAFT",
        },
      })
      await tx.planVersion.create({
        data: {
          planId: created.id,
          version: 1,
          status: "DRAFT",
          priceAmount: input.priceAmount ?? null,
          priceCurrency: input.priceCurrency ?? "USD",
          billingInterval: input.billingInterval ?? "MONTHLY",
          trialDays: input.trialDays ?? 0,
          entitlements,
          changeReason: input.changeReason ?? null,
          createdById: actor.user.id,
        },
      })
      return tx.plan.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          currentVersion: true,
          _count: { select: { versions: true, subscriptions: true } },
        },
      })
    })
    await logAudit({
      userId: actor.user.id,
      action: AuditAction.CREATE,
      resourceType: AuditResource.PLAN,
      resourceId: plan.id,
      detail: { event: "plan-created", slug: input.slug, kind: input.kind },
    })
    const versions = await db.planVersion.findMany({
      where: { planId: plan.id },
      include: { plan: { select: { name: true } } },
      orderBy: { version: "desc" },
    })
    return {
      ...toPlanSummary(plan),
      versions: versions.map(toPlanVersionSummary),
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError("A plan with this slug already exists.", 409)
    }
    throw err
  }
}

// The ONLY way to change a plan's price/limits/AI/MCP/features: a new
// DRAFT version. The published version (and every subscription on it)
// is untouched — a version edit can never rewrite existing terms.
export async function createPlanVersion(
  actor: AdminSession,
  planId: string,
  input: CreatePlanVersionInput
): Promise<PlanVersionSummary> {
  requireAdmin(actor, "MANAGE_PLANS")
  const entitlements = parseEntitlementsInput(input.entitlements)
  const plan = await getPlanOrThrow(planId)
  if (plan.status === "ARCHIVED") {
    throw new ApiError("An archived plan cannot get a new version.", 409)
  }
  const created = await createPlanVersionWithRetry(planId, () => ({
    planId,
    status: "DRAFT",
    priceAmount: input.priceAmount ?? null,
    priceCurrency: input.priceCurrency ?? "USD",
    billingInterval: input.billingInterval ?? "MONTHLY",
    trialDays: input.trialDays ?? 0,
    entitlements,
    changeReason: input.changeReason ?? null,
    createdById: actor.user.id,
  }))
  const version = { ...created, plan: { name: plan.name } }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CREATE,
    resourceType: AuditResource.PLAN,
    resourceId: planId,
    detail: {
      event: "plan-version-created",
      version: version.version,
      ...(input.changeReason ? { reason: input.changeReason } : {}),
    },
  })
  return toPlanVersionSummary(version)
}

// Publishing makes the version the plan's current version (what new
// subscribers get) and SUPERSEDES the previously published one.
// Existing subscriptions keep their effective version.
export async function publishPlanVersion(
  actor: AdminSession,
  planId: string,
  versionId: string,
  input: PublishPlanVersionInput
): Promise<PlanVersionSummary> {
  requireAdmin(actor, "PUBLISH_PLAN_VERSIONS")
  const version = await getVersionOrThrow(versionId)
  if (version.planId !== planId) {
    throw new ApiError("Plan version not found", 404)
  }
  if (version.status !== "DRAFT") {
    throw new ApiError("Only a draft version can be published.", 409)
  }
  const plan = await getPlanOrThrow(planId)
  if (plan.status === "ARCHIVED") {
    throw new ApiError("An archived plan cannot publish a version.", 409)
  }
  const now = new Date()
  // SRC-211: the DRAFT check + publish happen inside the
  // transaction as a CONDITIONAL update — two concurrent publishes
  // of the same draft cannot both pass the check. The loser's
  // updateMany matches zero rows and gets a 409 instead of
  // superseding the winner's just-published version. The previous
  // version is superseded conditionally too (only when it is still
  // PUBLISHED), for the same reason. The pre-transaction DRAFT
  // check above stays as the fast path for the common error.
  const published = await db.$transaction(async (tx) => {
    const claimed = await tx.planVersion.updateMany({
      where: { id: versionId, status: "DRAFT" },
      data: { status: "PUBLISHED", publishedAt: now },
    })
    if (claimed.count !== 1) {
      throw new ApiError(
        "This plan version was already published by another request.",
        409
      )
    }
    if (plan.currentVersionId && plan.currentVersionId !== versionId) {
      await tx.planVersion.updateMany({
        where: { id: plan.currentVersionId, status: "PUBLISHED" },
        data: { status: "SUPERSEDED" },
      })
    }
    const updated = await tx.planVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: { plan: { select: { name: true } } },
    })
    await tx.plan.update({
      where: { id: planId },
      data: { status: "PUBLISHED", currentVersionId: versionId },
    })
    return updated
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.PUBLISH,
    resourceType: AuditResource.PLAN,
    resourceId: planId,
    detail: {
      event: "plan-version-published",
      version: published.version,
      reason: input.reason,
    },
  })
  return toPlanVersionSummary(published)
}

// Archiving retires the plan: no new version can be created or
// published, and it can no longer be assigned. Existing subscriptions
// on its versions keep working — their terms are never rewritten.
export async function archivePlan(
  actor: AdminSession,
  planId: string,
  input: { reason?: string }
): Promise<PlanSummary> {
  requireAdmin(actor, "MANAGE_PLANS")
  const plan = await getPlanOrThrow(planId)
  if (plan.status === "ARCHIVED") {
    throw new ApiError("This plan is already archived.", 409)
  }
  const archived = await db.$transaction(async (tx) => {
    await tx.planVersion.updateMany({
      where: {
        planId,
        status: { in: ["DRAFT", "PUBLISHED"] },
      },
      data: { status: "ARCHIVED" },
    })
    return tx.plan.update({
      where: { id: planId },
      data: { status: "ARCHIVED", currentVersionId: null },
      include: {
        currentVersion: true,
        _count: { select: { versions: true, subscriptions: true } },
      },
    })
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.ARCHIVE,
    resourceType: AuditResource.PLAN,
    resourceId: planId,
    detail: {
      event: "plan-archived",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return toPlanSummary(archived)
}

// Copies the plan's current version's entitlements (or its latest
// version's, when it has no current version) into a new plan as
// version 1 DRAFT. No subscriptions move.
export async function duplicatePlan(
  actor: AdminSession,
  planId: string,
  input: DuplicatePlanInput
): Promise<PlanDetail> {
  requireAdmin(actor, "MANAGE_PLANS")
  const plan = await getPlanOrThrow(planId)
  // The current (published) version is the source; without one, the
  // latest version by number.
  const source = plan.currentVersionId
    ? await db.planVersion.findUnique({
        where: { id: plan.currentVersionId },
        include: { plan: { select: { name: true } } },
      })
    : await db.planVersion.findFirst({
        where: { planId },
        orderBy: { version: "desc" },
        include: { plan: { select: { name: true } } },
      })
  if (!source) throw new ApiError("Plan has no versions to copy.", 409)
  try {
    const created = await db.$transaction(async (tx) => {
      const copy = await tx.plan.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: plan.description,
          kind: plan.kind,
          isPrivate: plan.isPrivate,
          status: "DRAFT",
        },
      })
      await tx.planVersion.create({
        data: {
          planId: copy.id,
          version: 1,
          status: "DRAFT",
          priceAmount: source.priceAmount,
          priceCurrency: source.priceCurrency,
          billingInterval: source.billingInterval,
          trialDays: source.trialDays,
          entitlements: parseEntitlements(source.entitlements),
          changeReason: `Duplicated from ${plan.name} v${source.version}`,
          createdById: actor.user.id,
        },
      })
      return tx.plan.findUniqueOrThrow({
        where: { id: copy.id },
        include: {
          currentVersion: true,
          _count: { select: { versions: true, subscriptions: true } },
        },
      })
    })
    await logAudit({
      userId: actor.user.id,
      action: AuditAction.CREATE,
      resourceType: AuditResource.PLAN,
      resourceId: created.id,
      detail: {
        event: "plan-duplicated",
        fromPlanId: planId,
        fromVersion: source.version,
        slug: input.slug,
      },
    })
    const versions = await db.planVersion.findMany({
      where: { planId: created.id },
      include: { plan: { select: { name: true } } },
      orderBy: { version: "desc" },
    })
    return {
      ...toPlanSummary(created),
      versions: versions.map(toPlanVersionSummary),
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError("A plan with this slug already exists.", 409)
    }
    throw err
  }
}

// Field-level before/after comparison of two versions (price, limits,
// features, AI, MCP). Used by the admin UI's version comparison and by
// the migration preview's per-user limits change.
export async function comparePlanVersions(
  actor: AdminSession,
  fromVersionId: string,
  toVersionId: string
): Promise<VersionDiff> {
  requireAdmin(actor, "VIEW_PLAN_VERSIONS")
  const [from, to] = await Promise.all([
    getVersionOrThrow(fromVersionId),
    getVersionOrThrow(toVersionId),
  ])
  const fromFull = {
    ...toPlanVersionIdentity(from),
    entitlements: parseEntitlements(from.entitlements),
  }
  const toFull = {
    ...toPlanVersionIdentity(to),
    entitlements: parseEntitlements(to.entitlements),
  }
  return {
    from: toPlanVersionIdentity(from),
    to: toPlanVersionIdentity(to),
    changes: diffValues(fromFull, toFull),
  }
}

// ─── Subscriptions ────────────────────────────────────────────────────

export async function listSubscriptions(
  actor: AdminSession,
  filters: SubscriptionListQuery
): Promise<{
  subscriptions: SubscriptionSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_USERS")
  const { userId, planId, status, endsBefore, q, page, perPage, sort } = filters
  const where: Prisma.SubscriptionWhereInput = {}
  if (userId) where.userId = userId
  if (planId) where.planId = planId
  if (status) where.status = status
  if (endsBefore) where.currentPeriodEnd = { lte: new Date(endsBefore) }
  // ADM-032: match the subscriber's name or email (contains,
  // case-insensitive) — the same shape listPlans uses for its own q.
  if (q) {
    where.user = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    }
  }
  const [field = "createdAt", direction = "desc"] = sort.split(":")
  const orderBy: Prisma.SubscriptionOrderByWithRelationInput = {
    [field]: direction === "asc" ? "asc" : "desc",
  }
  const [total, rows] = await Promise.all([
    db.subscription.count({ where }),
    db.subscription.findMany({
      where,
      include: subscriptionInclude,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    subscriptions: rows.map((row) =>
      toSubscriptionSummary(row as SubscriptionWithRelations)
    ),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

// ─── Trial stats + ended trials (Phase A, seven admin pages §3.4) ────

// Trial state is DERIVED, never stored (Q4 — owner decision
// 2026-11-26): there is no Trial model and no trial-end timestamp
// column on Subscription.
// The derivation, verified against packages/database/prisma/schema.prisma:
// - trial state = Subscription.status = TRIALING
//   (SubscriptionStatus: ACTIVE / TRIALING / PAST_DUE / CANCELED / EXPIRED);
// - trial end = Subscription.currentPeriodEnd. Only
//   activateSubscriptionFromCheckout creates TRIALING rows, and it stores
//   the trial end there: the provider-reported trial end when present
//   (BIL-049/BIL-096), else now + PlanVersion.trialDays. The first
//   renewal flips TRIALING → ACTIVE via extendSubscriptionPeriod (which
//   writes a RENEWED event); the expiry job flips a TRIALING row past
//   its period end to EXPIRED (or CANCELED when cancelAtPeriodEnd),
//   writing an EXPIRED/CANCELED event.
// - trial length = PlanVersion.trialDays (Int @default(0)).

export type TrialStats = {
  activeTrials: number
  expiringSoon: number
  convertedLast30Days: number
  expiredLast30Days: number
}

// The only trial-origin marker in SubscriptionEvent history: the CREATED
// event reason activateSubscriptionFromCheckout writes for a trial
// checkout — `Checkout completed via ${provider} — trial until ${iso}`.
// No event field records "was TRIALING", and assignSubscription only
// ever creates ACTIVE rows, so this fixed token is what separates a
// trial's later RENEWED/EXPIRED/CANCELED events from ordinary paid
// renewals and expirations. If a trial flag is ever added to
// SubscriptionEvent, this is the one query to swap.
const TRIAL_CREATED_REASON_MARKER = "trial until"

// A superseded trial is a replacement, not an ending: when a new
// checkout supersedes the old row, the old row gets a CANCELED event
// whose reason starts with this prefix. It must not count as expired.
const SUPERSEDED_REASON_PREFIX = "Superseded by checkout"

// The subscription ids that started as trials (distinct — one CREATED
// event per subscription, but deduped defensively).
async function trialOriginSubscriptionIds(): Promise<string[]> {
  const rows = await db.subscriptionEvent.findMany({
    where: {
      type: "CREATED",
      reason: { contains: TRIAL_CREATED_REASON_MARKER },
    },
    select: { subscriptionId: true },
  })
  return [...new Set(rows.map((row) => row.subscriptionId))]
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export async function getTrialStats(
  actor: AdminSession,
  now: Date = new Date()
): Promise<TrialStats> {
  requireAdmin(actor, "VIEW_USERS")
  const in7Days = new Date(now.getTime() + SEVEN_DAYS_MS)
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)
  const [activeTrials, expiringSoon, trialIds, recentEvents] =
    await Promise.all([
      db.subscription.count({ where: { status: "TRIALING" } }),
      // Expiring in ≤7 days uses currentPeriodEnd — the trial end.
      // Includes rows already past their end whose expiry job has not
      // run yet (they are the most urgent); a TRIALING row with a NULL
      // currentPeriodEnd is not counted (Prisma `lte` excludes nulls),
      // and checkout always sets an end.
      db.subscription.count({
        where: { status: "TRIALING", currentPeriodEnd: { lte: in7Days } },
      }),
      trialOriginSubscriptionIds(),
      db.subscriptionEvent.findMany({
        where: {
          type: { in: ["RENEWED", "EXPIRED", "CANCELED"] },
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { subscriptionId: true, type: true, reason: true },
      }),
    ])
  const trialIdSet = new Set(trialIds)
  const converted = new Set<string>()
  const expired = new Set<string>()
  for (const event of recentEvents) {
    if (!trialIdSet.has(event.subscriptionId)) continue
    if (event.type === "RENEWED") {
      // The renewal is the conversion: extendSubscriptionPeriod flips
      // TRIALING → ACTIVE and writes the RENEWED event.
      converted.add(event.subscriptionId)
    } else if (
      event.type === "EXPIRED" ||
      (event.type === "CANCELED" &&
        !(event.reason ?? "").startsWith(SUPERSEDED_REASON_PREFIX))
    ) {
      expired.add(event.subscriptionId)
    }
  }
  return {
    activeTrials,
    expiringSoon,
    convertedLast30Days: converted.size,
    expiredLast30Days: expired.size,
  }
}

// Trials that ended: trial-origin subscriptions now EXPIRED or
// CANCELED, newest first. Same response shape as listSubscriptions so
// the trials table reuses its columns. Unlike the 30-day expired
// stat, this list is unbounded (every ended trial), and a superseded
// trial appears here as ended — its trial row did end when the new
// checkout replaced it, and the replacement shows under Active when
// it is itself a trial.
export async function listEndedTrials(
  actor: AdminSession,
  filters: SubscriptionListQuery
): Promise<{
  subscriptions: SubscriptionSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_USERS")
  const { planId, q, page, perPage, sort } = filters
  const trialIds = await trialOriginSubscriptionIds()
  const where: Prisma.SubscriptionWhereInput = {
    id: { in: trialIds },
    status: { in: ["EXPIRED", "CANCELED"] },
  }
  if (planId) where.planId = planId
  // ADM-032: match the subscriber's name or email (contains,
  // case-insensitive) — the same shape listSubscriptions uses.
  if (q) {
    where.user = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    }
  }
  const [field = "createdAt", direction = "desc"] = sort.split(":")
  const orderBy: Prisma.SubscriptionOrderByWithRelationInput = {
    [field]: direction === "asc" ? "asc" : "desc",
  }
  const [total, rows] = await Promise.all([
    db.subscription.count({ where }),
    db.subscription.findMany({
      where,
      include: subscriptionInclude,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    subscriptions: rows.map((row) =>
      toSubscriptionSummary(row as SubscriptionWithRelations)
    ),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

export async function getSubscription(
  actor: AdminSession,
  subscriptionId: string
): Promise<SubscriptionDetail> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const row = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      ...subscriptionInclude,
      events: {
        include: {
          fromPlanVersion: { select: { id: true, version: true } },
          toPlanVersion: { select: { id: true, version: true } },
          admin: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  })
  if (!row) throw new ApiError("Subscription not found", 404)
  return {
    ...toSubscriptionSummary(row as SubscriptionWithRelations),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      fromPlanVersion: event.fromPlanVersion,
      toPlanVersion: event.toPlanVersion,
      adminId: event.adminId,
      admin: event.admin,
      reason: event.reason,
      createdAt: event.createdAt,
    })),
  }
}

// The user's ACTIVE (or TRIALING) subscription with its effective plan
// version + entitlements — the read the admin UI's Package tab and the
// entitlement resolver share. Null when the user has no subscription
// (they fall back to the default Free plan).
//
// ADM-036: the `entitlements` here are the EFFECTIVE entitlements
// (getEffectiveEntitlements: overrides merged, emergency zeroing,
// suspended/disabled → null) — not the plan version's raw values.
// A field named `entitlements` must reflect what the user is actually
// allowed; the plan's raw values are one merge step away from that
// whenever an override is active.
export async function getUserSubscription(
  actor: AdminSession,
  userId: string
): Promise<
  (SubscriptionSummary & { entitlements: PlanEntitlements | null }) | null
> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const row = await findActiveSubscription(userId)
  if (!row) return null
  const effective = await getEffectiveEntitlements(userId)
  return {
    ...toSubscriptionSummary(row),
    entitlements: effective.entitlements,
  }
}

// ─── Subscription expiry (BIL-080) ──────────────────────────────────────

// A PAST_DUE subscription keeps its paid entitlements for this long
// past its period end while the renewal is retried, then it expires.
export const PAST_DUE_GRACE_DAYS = 7

function pastDueGraceEnd(row: {
  currentPeriodEnd: Date | null
  updatedAt: Date
}): Date {
  const base = row.currentPeriodEnd ?? row.updatedAt
  return new Date(base.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000)
}

// True when the row still grants entitlements right now. A row with
// no period end never expires on its own; a PAST_DUE row stays live
// through its grace window; any other row past its period end is
// expired (the expiry job is the writer — this is the read-side
// belt-and-braces for a missed run).
export function isSubscriptionPeriodLive(
  row: {
    status: SubscriptionStatus
    currentPeriodEnd: Date | null
    updatedAt: Date
  },
  now: Date = new Date()
): boolean {
  if (!row.currentPeriodEnd) return true
  if (row.currentPeriodEnd > now) return true
  if (row.status === "PAST_DUE") return now <= pastDueGraceEnd(row)
  return false
}

// The user's ACTIVE, TRIALING, or in-grace PAST_DUE subscription
// (latest first). One active subscription per user is enforced in the
// service (assign cancels the old one before creating the new one) —
// a DB partial unique index is not expressible in Prisma schema.
//
// BIL-080 belt-and-braces: a row past its `currentPeriodEnd` is
// treated as expired here even if the expiry job missed a run —
// except a PAST_DUE row inside its grace window (see
// `isSubscriptionPeriodLive`), which keeps its paid entitlements
// until the grace ends.
async function findActiveSubscription(
  userId: string,
  // DB-035: the migration re-reads inside its per-user transaction,
  // so the read sees the latest committed assignment instead of the
  // possibly-stale pre-transaction one. Defaults to the shared
  // client for every other caller.
  client: typeof db | Prisma.TransactionClient = db
): Promise<SubscriptionWithRelations | null> {
  const row = await client.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    include: subscriptionInclude,
    orderBy: { createdAt: "desc" },
  })
  if (!row) return null
  if (!isSubscriptionPeriodLive(row as SubscriptionWithRelations)) return null
  return row as SubscriptionWithRelations | null
}

// Assigns a PUBLISHED plan version to a user. In ONE transaction the
// existing active subscription (if any) is canceled with a CANCELED
// event and the new one is created with a CREATED event — the user is
// never left with two active subscriptions or none at all.
//
// DB-009 / DB-021: the one-active invariant is enforced three ways —
// a transaction-scoped advisory lock on the user serializes
// concurrent assigns, the supersede is a conditional updateMany
// (only while the row is still live), and the DB partial unique
// index "Subscription_single_active_idx" is the backstop (a P2002
// from it is a 409, not a 500). PAST_DUE rows are superseded too:
// a past-due subscription is the same live subscription in its
// grace window, and leaving it live beside the new ACTIVE row
// would violate the index.
export async function assignSubscription(
  actor: AdminSession,
  input: AssignSubscriptionInput
): Promise<SubscriptionSummary> {
  requireAdmin(actor, "MANAGE_SUBSCRIPTIONS")
  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const version = await getVersionOrThrow(input.planVersionId)
  if (version.status !== "PUBLISHED") {
    throw new ApiError("Only a published plan version can be assigned.", 409)
  }
  const now = new Date()
  let created
  try {
    created = await db.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"assign:" + input.userId}))`
      )
      const previous = await tx.subscription.findFirst({
        where: {
          userId: input.userId,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
        orderBy: { createdAt: "desc" },
      })
      if (previous) {
        const canceled = await tx.subscription.updateMany({
          where: {
            id: previous.id,
            status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
          },
          data: { status: "CANCELED" },
        })
        if (canceled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: previous.id,
              type: "CANCELED",
              fromPlanVersionId: previous.planVersionId,
              toPlanVersionId: null,
              adminId: actor.user.id,
              reason: input.reason,
            },
          })
        }
      }
      const next = await tx.subscription.create({
        data: {
          userId: input.userId,
          planId: version.planId,
          planVersionId: version.id,
          status: "ACTIVE",
          currentPeriodStart: now,
          currentPeriodEnd: periodEndFor(version.billingInterval, now),
          cancelAtPeriodEnd: false,
        },
      })
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: next.id,
          type: "CREATED",
          fromPlanVersionId: previous?.planVersionId ?? null,
          toPlanVersionId: version.id,
          adminId: actor.user.id,
          reason: input.reason,
        },
      })
      return tx.subscription.findUniqueOrThrow({
        where: { id: next.id },
        include: subscriptionInclude,
      })
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        "Another subscription was created for this user at the same time. Please try again.",
        409
      )
    }
    throw err
  }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.ASSIGN,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: created.id,
    detail: {
      event: "subscription-assigned",
      userId: input.userId,
      planVersionId: version.id,
      reason: input.reason,
    },
  })
  return toSubscriptionSummary(created as SubscriptionWithRelations)
}

// ─── Billing webhooks (Phase 8) ──────────────────────────────────────────
// System functions for the billing webhook handler. No actor: the
// provider's verified webhook IS the authorization, and the plan
// version is re-read from the DB here, never trusted from the event.

export type PublicPlan = {
  id: string
  name: string
  slug: string
  description: string | null
  kind: PlanKind
  version: {
    id: string
    version: number
    priceAmount: number | null
    priceCurrency: string
    billingInterval: BillingInterval
    trialDays: number
    entitlements: PlanEntitlements
  }
}

// Every published, non-private plan with its current published
// version — the marketing pricing page and the public plans API.
// Draft versions, unpublished plans, and private plans never appear.
export async function listPublishedPlans(): Promise<PublicPlan[]> {
  const plans = await db.plan.findMany({
    where: { status: "PUBLISHED", isPrivate: false },
    include: { currentVersion: true },
    orderBy: { createdAt: "asc" },
  })
  const result: PublicPlan[] = []
  for (const plan of plans) {
    const version = plan.currentVersion
    if (!version || version.status !== "PUBLISHED") continue
    result.push({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      kind: plan.kind,
      version: {
        id: version.id,
        version: version.version,
        priceAmount: version.priceAmount,
        priceCurrency: version.priceCurrency,
        billingInterval: version.billingInterval,
        trialDays: version.trialDays,
        entitlements: parseEntitlements(version.entitlements),
      },
    })
  }
  return result
}

// The signed-in user's own active subscription (if any) — for the
// dashboard billing page. Ownership is the check: a user only ever
// sees their own row. BIL-080: same period-live rule as
// `findActiveSubscription` — a row past its period end (outside a
// PAST_DUE grace window) is not shown as active.
export async function getMySubscription(
  userId: string
): Promise<SubscriptionSummary | null> {
  const row = await db.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    include: subscriptionInclude,
    orderBy: { createdAt: "desc" },
  })
  if (!row) return null
  if (!isSubscriptionPeriodLive(row as SubscriptionWithRelations)) return null
  return toSubscriptionSummary(row as SubscriptionWithRelations)
}

export type ActivateSubscriptionFromCheckoutInput = {
  userId: string
  planVersionId: string
  provider: BillingProvider
  providerSubscriptionId: string
  periodEnd?: Date | null
  // BIL-003 / BIL-042: a one-time purchase (the provider event
  // carries no subscription). `providerReference` is the
  // refund-matchable payment reference; `checkoutId` the checkout
  // session / order id.
  isOneTime?: boolean
  providerReference?: string
  checkoutId?: string
  // BIL-049 / BIL-096: the trial end the provider reports for this
  // checkout (e.g. Polar's subscription trial_end). When present
  // the subscription is created TRIALING ending then; when absent
  // and the version has trialDays, the trial end is now +
  // trialDays. Never set for non-trial checkouts.
  trialEnd?: Date | null
}

// Activate (or re-activate) a subscription from a verified checkout
// webhook. Same one-active-per-user transaction as
// assignSubscription: the previous ACTIVE/TRIALING/PAST_DUE
// subscription is canceled, the new one is created ACTIVE on the
// webhook's plan version with the provider subscription id stored.
// Idempotent per provider subscription: a repeated delivery for the
// same provider subscription id returns the existing row instead of
// creating a second subscription (advisory lock + the unique
// (provider, providerSubscriptionId) index, DB-002/DB-024).
//
// BIL-003 / BIL-042: a one-time purchase creates a OneTimePurchase
// row (the separate purchase record) AND a subscription whose
// period end is the finite access date — never a perpetual ACTIVE
// row. BIL-007: a remaining paid period on the superseded
// subscription is carried forward — the new period end is at least
// the old period end, so a re-checkout never silently discards
// time already paid for.
export async function activateSubscriptionFromCheckout(
  input: ActivateSubscriptionFromCheckoutInput
): Promise<SubscriptionSummary> {
  const version = await getVersionOrThrow(input.planVersionId)
  if (version.status !== "PUBLISHED") {
    throw new ApiError("Only a published plan version can be assigned.", 409)
  }
  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const now = new Date()
  const isOneTime =
    input.isOneTime === true ||
    version.billingInterval === "ONE_TIME" ||
    version.billingInterval === "CUSTOM"
  const providerReference =
    input.providerReference ?? input.providerSubscriptionId
  // BIL-049 / BIL-096: a trial checkout is TRIALING, not ACTIVE.
  // The old code created ACTIVE with a full paid period from now
  // and the first payment then extended it again — the customer
  // got the trial PLUS a full paid period. The trial end comes
  // from the provider when it reports one, else from the version's
  // trialDays (only when the provider gave no period end — an
  // explicit periodEnd is trusted as the paid end). One-time
  // purchases never trial. The first renewal flips TRIALING back
  // to ACTIVE via extendSubscriptionPeriod.
  const trialEnd =
    !isOneTime && input.trialEnd
      ? input.trialEnd
      : !isOneTime && version.trialDays > 0 && !input.periodEnd
        ? new Date(now.getTime() + version.trialDays * 24 * 60 * 60 * 1000)
        : null
  let created
  try {
    created = await db.$transaction(async (tx) => {
      // BIL-090: the duplicate guard is atomic — a transaction-scoped
      // advisory lock on (provider, providerSubscriptionId) serializes
      // concurrent deliveries of the same checkout event, so two
      // deliveries cannot both pass the `findFirst` below and create two
      // ACTIVE subscriptions. The unique (provider,
      // providerSubscriptionId) index (DB-002/DB-024) is the backstop.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.provider}:${input.providerSubscriptionId}`}))`
      )
      const duplicate = await tx.subscription.findFirst({
        where: {
          provider: input.provider,
          providerSubscriptionId: input.providerSubscriptionId,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
      })
      if (duplicate) {
        return tx.subscription.findUniqueOrThrow({
          where: { id: duplicate.id },
          include: subscriptionInclude,
        })
      }
      const previous = await tx.subscription.findFirst({
        where: {
          userId: input.userId,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
        orderBy: { createdAt: "desc" },
      })
      // BIL-007: the remaining paid period is preserved — the new
      // period end never falls before the old one.
      const preservedUntil =
        previous?.currentPeriodEnd && previous.currentPeriodEnd > now
          ? previous.currentPeriodEnd
          : null
      const computedEnd =
        trialEnd ??
        input.periodEnd ??
        periodEndFor(version.billingInterval, now)
      const accessEnd = isOneTime
        ? (input.periodEnd ?? oneTimeAccessEnd(now))
        : null
      let nextEnd = accessEnd ?? computedEnd
      if (nextEnd && preservedUntil && preservedUntil > nextEnd) {
        nextEnd = preservedUntil
      } else if (!nextEnd) {
        nextEnd = preservedUntil
      }
      if (previous) {
        const canceled = await tx.subscription.updateMany({
          where: {
            id: previous.id,
            status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
          },
          data: { status: "CANCELED" },
        })
        if (canceled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: previous.id,
              type: "CANCELED",
              fromPlanVersionId: previous.planVersionId,
              toPlanVersionId: null,
              adminId: null,
              reason: `Superseded by checkout via ${input.provider}${
                preservedUntil
                  ? ` — remaining paid period preserved until ${preservedUntil.toISOString()}`
                  : ""
              }`,
            },
          })
        }
      }
      const next = await tx.subscription.create({
        data: {
          userId: input.userId,
          planId: version.planId,
          planVersionId: version.id,
          status: trialEnd ? "TRIALING" : "ACTIVE",
          currentPeriodStart: now,
          currentPeriodEnd: nextEnd,
          cancelAtPeriodEnd: false,
          provider: input.provider,
          providerSubscriptionId: input.providerSubscriptionId,
        },
      })
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: next.id,
          type: "CREATED",
          fromPlanVersionId: previous?.planVersionId ?? null,
          toPlanVersionId: version.id,
          adminId: null,
          reason: isOneTime
            ? `One-time purchase via ${input.provider} — access until ${nextEnd?.toISOString() ?? "unknown"}`
            : `Checkout completed via ${input.provider}${
                trialEnd ? ` — trial until ${trialEnd.toISOString()}` : ""
              }${
                preservedUntil
                  ? ` — remaining paid period preserved until ${preservedUntil.toISOString()}`
                  : ""
              }`,
        },
      })
      // BIL-003: the separate purchase record for a one-time buy.
      // Idempotent per (provider, providerReference): a redelivery
      // that got past the subscription duplicate guard still writes
      // exactly one purchase row.
      if (isOneTime && nextEnd) {
        try {
          await tx.oneTimePurchase.create({
            data: {
              userId: input.userId,
              planId: version.planId,
              planVersionId: version.id,
              subscriptionId: next.id,
              provider: input.provider,
              providerReference,
              checkoutId: input.checkoutId ?? null,
              priceAmount: version.priceAmount,
              priceCurrency: version.priceCurrency,
              accessStart: now,
              accessEnd: nextEnd,
              status: "ACTIVE",
            },
          })
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            // Already recorded — the purchase row from the first
            // delivery stands; the subscription above is the same
            // grant.
          } else {
            throw err
          }
        }
      }
      return tx.subscription.findUniqueOrThrow({
        where: { id: next.id },
        include: subscriptionInclude,
      })
    })
  } catch (err) {
    // DB-024: the unique (provider, providerSubscriptionId) backstop
    // fired — a concurrent delivery already created the row. Return
    // it instead of a second ACTIVE subscription (or a 500).
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await db.subscription.findFirst({
        where: {
          provider: input.provider,
          providerSubscriptionId: input.providerSubscriptionId,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
        include: subscriptionInclude,
      })
      if (existing) {
        return toSubscriptionSummary(existing as SubscriptionWithRelations)
      }
      throw new ApiError(
        "This checkout was already processed. Please try again.",
        409
      )
    }
    throw err
  }
  await logAudit({
    userId: input.userId,
    action: AuditAction.ASSIGN,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: created.id,
    detail: {
      event: "subscription-activated-via-checkout",
      userId: input.userId,
      planVersionId: version.id,
      provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId,
      ...(isOneTime
        ? {
            oneTime: true,
            providerReference,
            accessEnd: created.currentPeriodEnd?.toISOString() ?? null,
          }
        : {}),
      ...(trialEnd
        ? {
            trial: true,
            trialEnd: trialEnd.toISOString(),
          }
        : {}),
    },
  })
  return toSubscriptionSummary(created as SubscriptionWithRelations)
}

// Cancel the active subscription that belongs to a provider
// subscription id (provider-side cancellation webhook). Returns null
// when no active subscription matches — the provider may cancel
// something SendCMS never activated, and that is not an error.
// BIL-090: the lookup is scoped to (provider,
// providerSubscriptionId) — provider id formats differ, and an id
// alone is not globally unique.
//
// DB-025: the cancel is a CONDITIONAL updateMany inside the
// transaction — two concurrent cancels cannot both write a
// CANCELED event. The loser finds zero rows to cancel and gets the
// already-canceled row back with no second event.
export async function cancelSubscriptionFromProvider(
  provider: BillingProvider,
  providerSubscriptionId: string,
  reason: string
): Promise<SubscriptionSummary | null> {
  const existing = await db.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
    },
    orderBy: { createdAt: "desc" },
  })
  if (!existing) {
    // Already canceled by a concurrent delivery? Return the row
    // without writing a second event.
    const canceled = await db.subscription.findFirst({
      where: {
        provider,
        providerSubscriptionId,
        status: { in: ["CANCELED", "EXPIRED"] },
      },
      include: subscriptionInclude,
      orderBy: { createdAt: "desc" },
    })
    return canceled
      ? toSubscriptionSummary(canceled as SubscriptionWithRelations)
      : null
  }
  const updated = await db.$transaction(async (tx) => {
    const canceled = await tx.subscription.updateMany({
      where: {
        id: existing.id,
        status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
      },
      data: { status: "CANCELED", cancelAtPeriodEnd: false },
    })
    if (canceled.count === 1) {
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: existing.id,
          type: "CANCELED",
          fromPlanVersionId: existing.planVersionId,
          toPlanVersionId: null,
          adminId: null,
          reason,
        },
      })
    }
    return tx.subscription.findUniqueOrThrow({
      where: { id: existing.id },
      include: subscriptionInclude,
    })
  })
  await logAudit({
    userId: existing.userId,
    action: AuditAction.CANCEL,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: existing.id,
    detail: { event: "subscription-canceled-by-provider", reason },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// Extend the current period of the active subscription that belongs
// to a provider subscription id (renewal webhook). When the provider
// does not give a period end, it is computed from the plan version's
// billing interval, extending from the current end when that is
// still in the future. Returns null when nothing matches.
// BIL-090: the lookup is scoped to (provider,
// providerSubscriptionId).
// BIL-085: the extension is monotonic — a stale or out-of-order
// renewal (an old `invoice.paid` retried after the next period
// already extended the subscription) is a no-op that returns the
// existing row, never moves the period end backwards, and writes no
// event. A successful extension writes a RENEWED event in the same
// transaction as the update (SRC-226 — renewals are visible in
// history), and revives a PAST_DUE subscription back to ACTIVE.
// BIL-086: a renewal for a `cancelAtPeriodEnd` subscription does
// NOT extend it — the period ended as scheduled, so the row flips
// to CANCELED with a CANCELED event instead.
// DB-010: `providerEventId` makes the extension idempotent per
// webhook event — a provider retry after a crash between the apply
// and the BillingEvent processedAt stamp finds the RENEWED event
// for that event id and no-ops instead of extending a second time.
export async function extendSubscriptionPeriod(
  provider: BillingProvider,
  providerSubscriptionId: string,
  periodEnd: Date | null,
  providerEventId?: string | null
): Promise<SubscriptionSummary | null> {
  const existing = await db.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
    },
    include: {
      planVersion: { select: { billingInterval: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  if (!existing) return null
  if (providerEventId) {
    const alreadyApplied = await db.subscriptionEvent.findFirst({
      where: {
        subscriptionId: existing.id,
        type: "RENEWED",
        providerEventId,
      },
      select: { id: true },
    })
    if (alreadyApplied) {
      const unchanged = await db.subscription.findUniqueOrThrow({
        where: { id: existing.id },
        include: subscriptionInclude,
      })
      return toSubscriptionSummary(unchanged as SubscriptionWithRelations)
    }
  }
  // BIL-086: the customer asked for this subscription to end at the
  // period boundary — a renewal landing on it ends the subscription
  // instead of silently extending it past the boundary.
  if (existing.cancelAtPeriodEnd) {
    const canceled = await db.$transaction(async (tx) => {
      const claimed = await tx.subscription.updateMany({
        where: {
          id: existing.id,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
          cancelAtPeriodEnd: true,
        },
        data: { status: "CANCELED", cancelAtPeriodEnd: false },
      })
      if (claimed.count === 1) {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: existing.id,
            type: "CANCELED",
            fromPlanVersionId: existing.planVersionId,
            toPlanVersionId: null,
            adminId: null,
            reason: `Period ended after cancel-at-period-end; renewal via ${provider} not applied`,
            ...(providerEventId ? { providerEventId } : {}),
          },
        })
      }
      return tx.subscription.findUniqueOrThrow({
        where: { id: existing.id },
        include: subscriptionInclude,
      })
    })
    await logAudit({
      userId: existing.userId,
      action: AuditAction.CANCEL,
      resourceType: AuditResource.SUBSCRIPTION,
      resourceId: existing.id,
      detail: {
        event: "subscription-canceled-at-period-end",
        provider,
        providerSubscriptionId,
        renewalNotApplied: true,
      },
    })
    return toSubscriptionSummary(canceled as SubscriptionWithRelations)
  }
  const now = new Date()
  const base =
    existing.currentPeriodEnd && existing.currentPeriodEnd > now
      ? existing.currentPeriodEnd
      : now
  const nextEnd =
    periodEnd ?? periodEndFor(existing.planVersion.billingInterval, base)
  // A null derived end (a non-recurring interval has no next period)
  // is a no-op: there is nothing to extend to.
  if (!nextEnd) {
    const unchanged = await db.subscription.findUniqueOrThrow({
      where: { id: existing.id },
      include: subscriptionInclude,
    })
    return toSubscriptionSummary(unchanged as SubscriptionWithRelations)
  }
  if (existing.currentPeriodEnd && nextEnd <= existing.currentPeriodEnd) {
    const unchanged = await db.subscription.findUniqueOrThrow({
      where: { id: existing.id },
      include: subscriptionInclude,
    })
    return toSubscriptionSummary(unchanged as SubscriptionWithRelations)
  }
  const updated = await db.$transaction(async (tx) => {
    const renewed = await tx.subscription.update({
      where: { id: existing.id },
      data: { currentPeriodEnd: nextEnd, status: "ACTIVE" },
      include: subscriptionInclude,
    })
    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: existing.id,
        type: "RENEWED",
        fromPlanVersionId: existing.planVersionId,
        toPlanVersionId: existing.planVersionId,
        adminId: null,
        reason: `Renewed via ${provider}`,
        ...(providerEventId ? { providerEventId } : {}),
      },
    })
    return renewed
  })
  await logAudit({
    userId: existing.userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: existing.id,
    detail: {
      event: "subscription-renewed",
      provider,
      providerSubscriptionId,
      currentPeriodEnd: nextEnd.toISOString(),
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// Sync a subscription from a provider-side update (BIL-005 /
// BIL-006 / BIL-045): status / period end / cancel-at-period-end /
// plan version. Returns null when no row matches — a provider-side
// change for a subscription SendCMS never activated is not an
// error. A "canceled" status cancels (one CANCELED event, DB-025
// conditional); "past_due"/"unpaid"/"suspended" marks PAST_DUE;
// "plan-changed" moves the version with a MIGRATED event; anything
// else only syncs the period end / cancel flag.
export async function syncSubscriptionFromProvider(
  provider: BillingProvider,
  providerSubscriptionId: string,
  update: {
    status?: string | null
    periodEnd?: Date | null
    cancelAtPeriodEnd?: boolean | null
    planVersionId?: string | null
  }
): Promise<SubscriptionSummary | null> {
  const existing = await db.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
    },
    orderBy: { createdAt: "desc" },
  })
  if (!existing) return null
  const status = update.status?.toLowerCase() ?? null
  if (status === "canceled" || status === "revoked" || status === "expired") {
    return cancelSubscriptionFromProvider(
      provider,
      providerSubscriptionId,
      `Canceled by ${provider} (${status})`
    )
  }
  if (status === "past_due" || status === "unpaid" || status === "suspended") {
    return markSubscriptionPastDue(provider, providerSubscriptionId)
  }
  const data: {
    currentPeriodEnd?: Date
    cancelAtPeriodEnd?: boolean
    planId?: string
    planVersionId?: string
  } = {}
  if (update.periodEnd) data.currentPeriodEnd = update.periodEnd
  if (
    update.cancelAtPeriodEnd !== null &&
    update.cancelAtPeriodEnd !== undefined
  ) {
    data.cancelAtPeriodEnd = update.cancelAtPeriodEnd
  }
  let eventType: SubscriptionEventType | null = null
  let fromVersionId: string | null = null
  if (update.planVersionId && update.planVersionId !== existing.planVersionId) {
    const target = await getVersionOrThrow(update.planVersionId)
    if (target.status !== "PUBLISHED") {
      throw new ApiError("Only a published plan version can be assigned.", 409)
    }
    data.planId = target.planId
    data.planVersionId = target.id
    eventType = "MIGRATED"
    fromVersionId = existing.planVersionId
  }
  if (Object.keys(data).length === 0) {
    const unchanged = await db.subscription.findUniqueOrThrow({
      where: { id: existing.id },
      include: subscriptionInclude,
    })
    return toSubscriptionSummary(unchanged as SubscriptionWithRelations)
  }
  const updated = await db.$transaction(async (tx) => {
    const synced = await tx.subscription.update({
      where: { id: existing.id },
      data,
      include: subscriptionInclude,
    })
    if (eventType) {
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: existing.id,
          type: eventType,
          fromPlanVersionId: fromVersionId,
          toPlanVersionId: update.planVersionId ?? null,
          adminId: null,
          reason: `Plan changed at ${provider}`,
        },
      })
    }
    return synced
  })
  await logAudit({
    userId: existing.userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: existing.id,
    detail: {
      event: "subscription-synced-from-provider",
      provider,
      providerSubscriptionId,
      ...(status ? { status } : {}),
      ...(update.periodEnd
        ? { currentPeriodEnd: update.periodEnd.toISOString() }
        : {}),
      ...(update.cancelAtPeriodEnd !== null &&
      update.cancelAtPeriodEnd !== undefined
        ? { cancelAtPeriodEnd: update.cancelAtPeriodEnd }
        : {}),
      ...(update.planVersionId ? { planVersionId: update.planVersionId } : {}),
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// Apply a provider refund / chargeback (BIL-081 / BIL-004 / BIL-047,
// owner decision 2026-11-25). Resolution order: the subscription
// behind `providerSubscriptionId`, then the one-time purchase behind
// `providerReference`. FULL refund → cancel the matching
// subscription (downgrade to Free is automatic — the resolver falls
// back to the Free plan) + CANCELED event + audit, and flip the
// linked one-time purchase to REFUNDED. PARTIAL refund → KEEP the
// subscription and write a REFUNDED event so the refund surfaces in
// the admin subscription timeline. Returns null when nothing
// matches — an unmatched refund is recorded by the billing service
// on the BillingEvent row instead.
export async function applyRefund(
  provider: BillingProvider,
  input: {
    providerSubscriptionId: string | null
    providerReference?: string | null
    fullRefund: boolean
    amountMinor?: number | null
  }
): Promise<SubscriptionSummary | null> {
  if (input.providerSubscriptionId) {
    const existing = await db.subscription.findFirst({
      where: {
        provider,
        providerSubscriptionId: input.providerSubscriptionId,
        status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
      },
      orderBy: { createdAt: "desc" },
    })
    if (existing) {
      if (input.fullRefund) {
        const canceled = await cancelSubscriptionFromProvider(
          provider,
          input.providerSubscriptionId,
          `Refunded in full by ${provider}${
            input.amountMinor !== null && input.amountMinor !== undefined
              ? ` (${input.amountMinor})`
              : ""
          }`
        )
        await db.oneTimePurchase.updateMany({
          where: { subscriptionId: existing.id, status: "ACTIVE" },
          data: { status: "REFUNDED" },
        })
        return canceled
      }
      const kept = await db.$transaction(async (tx) => {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: existing.id,
            type: "REFUNDED",
            fromPlanVersionId: existing.planVersionId,
            toPlanVersionId: existing.planVersionId,
            adminId: null,
            reason: `Partial refund by ${provider}${
              input.amountMinor !== null && input.amountMinor !== undefined
                ? ` (${input.amountMinor})`
                : ""
            } — subscription kept`,
          },
        })
        return tx.subscription.findUniqueOrThrow({
          where: { id: existing.id },
          include: subscriptionInclude,
        })
      })
      await logAudit({
        userId: existing.userId,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.SUBSCRIPTION,
        resourceId: existing.id,
        detail: {
          event: "subscription-partial-refund",
          provider,
          providerSubscriptionId: input.providerSubscriptionId,
          amountMinor: input.amountMinor ?? null,
        },
      })
      return toSubscriptionSummary(kept as SubscriptionWithRelations)
    }
  }
  if (input.providerReference) {
    const purchase = await db.oneTimePurchase.findFirst({
      where: {
        provider,
        providerReference: input.providerReference,
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    })
    if (purchase) {
      await db.oneTimePurchase.update({
        where: { id: purchase.id },
        data: { status: "REFUNDED" },
      })
      if (input.fullRefund && purchase.subscriptionId) {
        const sub = await db.subscription.findUnique({
          where: { id: purchase.subscriptionId },
          select: { provider: true, providerSubscriptionId: true },
        })
        if (sub?.provider && sub.providerSubscriptionId) {
          return cancelSubscriptionFromProvider(
            sub.provider,
            sub.providerSubscriptionId,
            `One-time purchase refunded in full by ${provider}`
          )
        }
      }
      if (purchase.subscriptionId) {
        const row = await db.subscription.findUnique({
          where: { id: purchase.subscriptionId },
          include: subscriptionInclude,
        })
        return row
          ? toSubscriptionSummary(row as SubscriptionWithRelations)
          : null
      }
      return null
    }
  }
  return null
}

// BIL-080: mark the subscription behind a provider subscription id
// PAST_DUE after a failed renewal payment. Entitlements survive
// through the grace window (see `isSubscriptionPeriodLive`); the
// expiry job flips it to EXPIRED once the grace ends, and a
// successful renewal revives it via `extendSubscriptionPeriod`.
// Returns null when nothing matches — a payment failure for a
// subscription SendCMS never activated is not an error. The
// PAYMENT_FAILED SubscriptionEvent (Wave 8) is the timeline record;
// the audit row is the second record. The transition is conditional
// (only while still ACTIVE/TRIALING), so a retried failure event
// cannot write a second PAYMENT_FAILED event.
export async function markSubscriptionPastDue(
  provider: BillingProvider,
  providerSubscriptionId: string
): Promise<SubscriptionSummary | null> {
  const existing = await db.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
      status: { in: ["ACTIVE", "TRIALING"] },
    },
    orderBy: { createdAt: "desc" },
  })
  if (!existing) return null
  const updated = await db.$transaction(async (tx) => {
    const claimed = await tx.subscription.updateMany({
      where: {
        id: existing.id,
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      data: { status: "PAST_DUE" },
    })
    if (claimed.count === 1) {
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: existing.id,
          type: "PAYMENT_FAILED",
          fromPlanVersionId: existing.planVersionId,
          toPlanVersionId: existing.planVersionId,
          adminId: null,
          reason: `Payment failed via ${provider} — grace window of ${PAST_DUE_GRACE_DAYS} days`,
        },
      })
    }
    return tx.subscription.findUniqueOrThrow({
      where: { id: existing.id },
      include: subscriptionInclude,
    })
  })
  await logAudit({
    userId: existing.userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: existing.id,
    detail: {
      event: "subscription-payment-failed",
      provider,
      providerSubscriptionId,
      graceDays: PAST_DUE_GRACE_DAYS,
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// BIL-080: the daily expiry job (Wave 9 wires the cron/worker
// schedule — this is the job function). For every ACTIVE / TRIALING /
// PAST_DUE subscription whose period has ended:
// - `cancelAtPeriodEnd` → CANCELED (the user asked to cancel at the
//   end of the paid period) with a CANCELED event;
// - otherwise → EXPIRED with an EXPIRED event — except a PAST_DUE
//   subscription still inside its grace window, which is left alone
//   to be retried.
// `dryRun` reports what would change without writing anything.
// Returns the per-subscription outcomes; the caller logs them.
export async function expireSubscriptions(
  now: Date = new Date(),
  opts: { dryRun?: boolean } = {}
): Promise<
  {
    subscriptionId: string
    userId: string
    fromStatus: SubscriptionStatus
    toStatus: "CANCELED" | "EXPIRED"
    dryRun: boolean
  }[]
> {
  const due = await db.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
      currentPeriodEnd: { lt: now },
    },
    orderBy: { createdAt: "asc" },
  })
  const results: {
    subscriptionId: string
    userId: string
    fromStatus: SubscriptionStatus
    toStatus: "CANCELED" | "EXPIRED"
    dryRun: boolean
  }[] = []
  for (const row of due) {
    if (row.status === "PAST_DUE" && now <= pastDueGraceEnd(row)) {
      continue
    }
    const toStatus = row.cancelAtPeriodEnd ? "CANCELED" : "EXPIRED"
    const eventType = row.cancelAtPeriodEnd ? "CANCELED" : "EXPIRED"
    if (!opts.dryRun) {
      await db.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: row.id },
          data: { status: toStatus, cancelAtPeriodEnd: false },
        })
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: row.id,
            type: eventType,
            fromPlanVersionId: row.planVersionId,
            toPlanVersionId: null,
            adminId: null,
            reason: row.cancelAtPeriodEnd
              ? "Period ended after cancel-at-period-end"
              : "Period ended without renewal",
          },
        })
        // BIL-003: a one-time purchase tied to this subscription
        // expires with it — its finite access date is enforced here.
        await tx.oneTimePurchase.updateMany({
          where: { subscriptionId: row.id, status: "ACTIVE" },
          data: { status: "EXPIRED" },
        })
      })
      await logAudit({
        userId: row.userId,
        action: AuditAction.UPDATE,
        resourceType: AuditResource.SUBSCRIPTION,
        resourceId: row.id,
        detail: {
          event: "subscription-expired",
          fromStatus: row.status,
          toStatus,
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        },
      })
    }
    results.push({
      subscriptionId: row.id,
      userId: row.userId,
      fromStatus: row.status,
      toStatus,
      dryRun: opts.dryRun ?? false,
    })
  }
  // BIL-003: a one-time purchase whose access date passed expires
  // even if its subscription row was already ended another way (or
  // the purchase outlives the subscription row). No separate
  // subscription flip here — the subscription side is handled by
  // the loop above; this only flips the purchase record itself.
  if (!opts.dryRun) {
    await db.oneTimePurchase.updateMany({
      where: { status: "ACTIVE", accessEnd: { lt: now } },
      data: { status: "EXPIRED" },
    })
  }
  return results
}

// Migration preview: which subscriptions a migration to `planVersionId`
// would touch, with a per-user before/after comparison (price + limits
// + features + AI + MCP). Nothing is changed — the admin reviews this
// first, then executes with the same selection.
export async function getMigrationPreview(
  actor: AdminSession,
  input: MigrationPreviewInput
): Promise<MigrationPreview> {
  requireAdmin(actor, "MIGRATE_SUBSCRIPTIONS")
  const target = await getVersionOrThrow(input.planVersionId)
  if (target.status !== "PUBLISHED") {
    throw new ApiError(
      "Only a published plan version can be a migration target.",
      409
    )
  }
  const targetFull = {
    ...toPlanVersionIdentity(target),
    entitlements: parseEntitlements(target.entitlements),
  }
  const targetPlan = await db.plan.findUniqueOrThrow({
    where: { id: target.planId },
    select: { id: true, name: true, slug: true },
  })

  // The affected set: either the listed users' active subscriptions, or
  // every active subscription on the given version.
  //
  // SRC-223: the preview window is 100 rows, but `affectedCount` is
  // the size of the WHOLE affected set — the admin decides on that
  // number, so it comes from a separate count(), never from the
  // window's length (the old code derived it from a `take: 101`
  // window and capped it at 101). The `as never` casts on both
  // branches are gone: the query shape (subscriptionInclude) IS the
  // declared row type, so the rows assign directly.
  let subscriptions: SubscriptionWithRelations[]
  let skippedUserIds: string[] = []
  // Set only by the allOnVersionId branch (its window is capped, so
  // the exact total needs the count below); the userIds branch is
  // uncapped and counts its affected rows directly.
  let totalAffected: number | null = null
  if (input.allOnVersionId) {
    const [rows, total] = await Promise.all([
      db.subscription.findMany({
        where: {
          planVersionId: input.allOnVersionId,
          status: { in: ["ACTIVE", "TRIALING"] },
        },
        include: subscriptionInclude,
        orderBy: { createdAt: "asc" },
        take: 101,
      }),
      // A migration onto the version the rows already sit on affects
      // nobody; otherwise every ACTIVE/TRIALING row on the version
      // is affected (the window query's filter, without its cap).
      input.allOnVersionId === input.planVersionId
        ? Promise.resolve(0)
        : db.subscription.count({
            where: {
              planVersionId: input.allOnVersionId,
              status: { in: ["ACTIVE", "TRIALING"] },
            },
          }),
    ])
    subscriptions = rows
    totalAffected = total
  } else {
    const userIds = input.userIds ?? []
    const rows = await db.subscription.findMany({
      where: {
        userId: { in: userIds },
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      include: subscriptionInclude,
      orderBy: { createdAt: "asc" },
    })
    const foundUserIds = new Set(rows.map((r) => r.userId))
    skippedUserIds = userIds.filter((id) => !foundUserIds.has(id))
    subscriptions = rows
  }

  // Users already on the target version are not affected.
  const affected = subscriptions.filter(
    (row) => row.planVersionId !== input.planVersionId
  )
  const affectedCount = totalAffected ?? affected.length
  skippedUserIds = [
    ...skippedUserIds,
    ...subscriptions
      .filter((row) => row.planVersionId === input.planVersionId)
      .map((row) => row.userId),
  ]
  const previewTruncated = affectedCount > 100
  const previewRows = affected.slice(0, 100)
  const users: MigrationPreviewUser[] = previewRows.map((row) => {
    const fromFull = {
      ...toPlanVersionIdentity(row.planVersion),
      entitlements: parseEntitlements(row.planVersion.entitlements),
    }
    return {
      userId: row.userId,
      email: row.user.email,
      name: row.user.name,
      fromVersion: {
        id: row.planVersionId,
        version: row.planVersion.version,
        planName: row.planVersion.plan.name,
      },
      toVersion: {
        id: target.id,
        version: target.version,
        planName: targetPlan.name,
      },
      priceChange: {
        from: row.planVersion.priceAmount,
        to: target.priceAmount,
        currency: target.priceCurrency,
      },
      limitsChange: diffValues(fromFull, targetFull),
    }
  })
  // BIL-089: whether executing this migration also changes what
  // the provider bills. A migration is provider-synced where the
  // provider supports a plan-change API (Stripe, PayPal, Polar);
  // Freemius and Gumroad have no plan-change API, and a
  // provider-less row bills nowhere, so those stay SendCMS-only and
  // the preview says so plainly instead of implying a price change
  // that will never be charged. The execute step records exactly
  // which subscriptions were provider-synced and which were not.
  const affectedProviders = new Set(
    affected
      .map((row) => row.provider)
      .filter((p): p is BillingProvider => p != null)
  )
  const unsupportedProviders = [...affectedProviders].filter(
    (p) => p === "FREEMIUS" || p === "GUMROAD"
  )
  const hasLocalOnlyRows = affected.some((row) => row.provider == null)
  const billingUnchanged = unsupportedProviders.length > 0 || hasLocalOnlyRows
  const providerUpdateSupported = affected.length > 0 && !billingUnchanged
  const providerUpdateNote = billingUnchanged
    ? [
        ...(unsupportedProviders.length > 0
          ? [
              `Subscriptions on ${unsupportedProviders.join(", ")} will NOT be updated at the provider — ${unsupportedProviders.join("/")} has no subscription plan-change API, so those customers keep billing on their old plan until they re-subscribe.`,
            ]
          : []),
        ...(hasLocalOnlyRows
          ? [
              "Some subscriptions have no provider attached — they are SendCMS-only and billing is unaffected.",
            ]
          : []),
      ].join(" ")
    : undefined
  return {
    targetPlanVersionId: target.id,
    targetPlan,
    affectedCount,
    users,
    previewTruncated,
    skippedUserIds,
    billingUnchanged,
    providerUpdateSupported,
    ...(providerUpdateNote ? { providerUpdateNote } : {}),
  }
}

// Executes a migration for EXACTLY the selected userIds — never the
// whole plan, never unselected subscriptions. Each subscription's
// version change + its MIGRATED event happen in one transaction, so a
// version change is never recorded without its event. Rollback is a
// new migration back to the previous version — history is never
// rewritten.
//
// SRC-224: the migration reports per-user results instead of
// throwing on the first failure — a mid-loop failure used to leave
// earlier users migrated, later users not, with no audit row at all.
// One giant transaction over the whole (up to 1000-user, or
// unbounded allOnVersionId) set would risk statement timeouts, so
// each user is attempted in turn: a failure is recorded in
// `failedUserIds` and the rest continue, and the audit row is
// written even on partial failure, naming migrated/skipped/failed.
// DB-035: the version is re-checked INSIDE the per-user transaction
// (see below) — a concurrent re-assignment is reported as skipped,
// never silently overwritten.
//
// BIL-089: when `opts.updateAtProvider` is given (the billing
// dispatcher — Stripe/PayPal/Polar support a plan change), the
// provider subscription is updated BEFORE the local row moves, so
// the provider and SendCMS never disagree about what is billed.
// A provider failure (502) fails that user — the local row is left
// untouched — and the rest continue. A provider that reports
// `updated: false` (Freemius/Gumroad — no plan-change API) migrates
// SendCMS-only and the reason is recorded in the audit detail.
// Without a callback the migration is SendCMS-only and the audit
// says so. Judgment call (2026-11-25, Wave 8 Stream A): provider-
// synced where the provider supports it, SendCMS-only recorded
// otherwise — the alternative (refusing to migrate any
// provider-billed subscription) would block admin operations on
// plans whose providers simply have no API for this.
export async function executeMigration(
  actor: AdminSession,
  input: ExecuteMigrationInput,
  opts: { updateAtProvider?: ProviderUpdateFn } = {}
): Promise<{
  migratedUserIds: string[]
  skippedUserIds: string[]
  failedUserIds: string[]
  count: number
}> {
  requireAdmin(actor, "MIGRATE_SUBSCRIPTIONS")
  const target = await getVersionOrThrow(input.planVersionId)
  if (target.status !== "PUBLISHED") {
    throw new ApiError(
      "Only a published plan version can be a migration target.",
      409
    )
  }
  // Resolve the affected set. allOnVersionId means EVERY active
  // subscription on that version (no preview cap) — executing from
  // the previewed first 100 would silently drop the rest.
  const userIds = input.allOnVersionId
    ? (
        await db.subscription.findMany({
          where: {
            planVersionId: input.allOnVersionId,
            status: { in: ["ACTIVE", "TRIALING"] },
          },
          select: { userId: true },
        })
      ).map((row) => row.userId)
    : (input.userIds ?? [])
  const migratedUserIds: string[] = []
  const skippedUserIds: string[] = []
  const failedUserIds: string[] = []
  const providerUpdateNotes: Record<string, string> = {}
  for (const userId of userIds) {
    const current = await findActiveSubscription(userId)
    if (!current || current.planVersionId === input.planVersionId) {
      skippedUserIds.push(userId)
      continue
    }
    // BIL-089: provider first, local second. A provider failure
    // fails this user before anything local changes.
    if (
      opts.updateAtProvider &&
      current.provider &&
      current.providerSubscriptionId
    ) {
      try {
        // The provider plan-change needs the target version's
        // billing terms and the customer's email/name (the
        // dispatcher builds the provider's product/plan from them).
        // The success/cancel URLs are checkout-session fields the
        // plan-change path never uses — the dashboard billing URL
        // is passed as a neutral value.
        const customer = await db.user.findUnique({
          where: { id: userId },
          select: { email: true, name: true },
        })
        if (!customer) {
          failedUserIds.push(userId)
          continue
        }
        const dashboardUrl =
          process.env.NEXT_PUBLIC_DASHBOARD_URL ??
          "https://dashboard.sendcms.bond"
        const outcome = await opts.updateAtProvider(
          current.provider,
          current.providerSubscriptionId,
          {
            version: {
              id: target.id,
              planId: target.planId,
              planName: target.plan.name,
              priceAmount: target.priceAmount,
              priceCurrency: target.priceCurrency,
              billingInterval: target.billingInterval,
              trialDays: target.trialDays,
            },
            customer: {
              userId,
              email: customer.email,
              name: customer.name,
            },
            successUrl: `${dashboardUrl}/dashboard/billing`,
            cancelUrl: `${dashboardUrl}/dashboard/billing`,
            // BIL-014: one migration attempt per user+version, so a
            // retried migration cannot mint duplicate provider
            // objects at the provider.
            idempotencyKey: `migration:${target.id}:${userId}`,
          }
        )
        if (!outcome.updated) {
          providerUpdateNotes[userId] =
            outcome.reason ?? "Provider plan change not supported"
        }
      } catch (err) {
        logger.warn("migration provider update failed, skipping user", {
          userId,
          provider: current.provider,
          error: err,
        })
        failedUserIds.push(userId)
        continue
      }
    } else if (current.provider && current.providerSubscriptionId) {
      providerUpdateNotes[userId] =
        "Provider subscription not updated — no provider callback supplied (SendCMS-only migration)"
    }
    // SRC-224: a failure for one user is recorded, not thrown — the
    // remaining users still migrate and the audit below still runs.
    try {
      const moved = await db.$transaction(async (tx) => {
        // DB-035: the read above is outside this transaction, so a
        // concurrent assignment (admin assign, checkout webhook)
        // between the read and this write would be silently
        // reverted by an unconditional update. Re-read inside the
        // transaction and re-check the version; the conditional
        // update below is the second guard — it only matches while
        // the row still sits on the previewed version.
        const fresh = await findActiveSubscription(userId, tx)
        if (!fresh || fresh.planVersionId !== current.planVersionId) {
          return false
        }
        const updated = await tx.subscription.updateMany({
          where: {
            id: current.id,
            planVersionId: current.planVersionId,
          },
          data: { planId: target.planId, planVersionId: target.id },
        })
        if (updated.count !== 1) return false
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: current.id,
            type: "MIGRATED",
            fromPlanVersionId: current.planVersionId,
            toPlanVersionId: target.id,
            adminId: actor.user.id,
            reason: input.reason,
          },
        })
        return true
      })
      if (moved) migratedUserIds.push(userId)
      else {
        // The provider was already updated above but the local row
        // moved concurrently — the admin can see the note in the
        // audit row and re-run the migration for this user.
        if (
          opts.updateAtProvider &&
          current.provider &&
          current.providerSubscriptionId &&
          !providerUpdateNotes[userId]
        ) {
          providerUpdateNotes[userId] =
            "Provider plan was updated but the local subscription moved concurrently — re-run the migration for this user"
        }
        skippedUserIds.push(userId)
      }
    } catch (err) {
      logger.warn("migration failed for user, continuing with the rest", {
        userId,
        error: err,
      })
      failedUserIds.push(userId)
    }
  }
  // SRC-224: the audit row is written even on partial failure, so a
  // partial migration always has a record.
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.MIGRATE,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: input.planVersionId,
    detail: {
      event: "subscriptions-migrated",
      planVersionId: target.id,
      migratedCount: migratedUserIds.length,
      skippedCount: skippedUserIds.length,
      failedCount: failedUserIds.length,
      failedUserIds,
      reason: input.reason,
      // BIL-089: per-user provider-sync record — which users'
      // providers were updated and which stayed SendCMS-only (and
      // why). Empty when every migrated row was provider-synced.
      providerUpdateNotes,
    },
  })
  return {
    migratedUserIds,
    skippedUserIds,
    failedUserIds,
    count: migratedUserIds.length,
  }
}

// Cancels a subscription. With `cancelAtPeriodEnd` the subscription
// stays ACTIVE until its period ends (the flag is the record — the
// actual expiry is a later job's concern); otherwise it is canceled
// immediately with a CANCELED event.
//
// BIL-001 / BIL-082: a provider-attached subscription is canceled
// at the PROVIDER first (via `opts.cancelAtProvider`, the billing
// dispatcher). The provider call is the gate: a provider failure
// (502) stops the cancel — the local row is never canceled while
// the provider keeps billing. A provider row with no callback is a
// hard 502, never a silent local-only cancel (the old behavior that
// let billing continue invisibly). When the provider reports the
// cancel as scheduled-at-period-end (`immediate: false`), the
// local row takes the same state. A provider that cancels
// immediately even when period-end was requested (PayPal/Freemius
// have no at-period-end) is mirrored as an immediate local cancel
// with an audit note, so the two sides never disagree.
// DB-045: a cancel-at-period-end writes a CANCEL_SCHEDULED event
// (it used to write nothing). DB-025: the immediate cancel is a
// conditional updateMany — exactly one CANCELED event.
export async function cancelSubscription(
  actor: AdminSession,
  subscriptionId: string,
  input: CancelSubscriptionInput,
  opts: { cancelAtProvider?: ProviderCancelFn } = {}
): Promise<SubscriptionSummary> {
  requireAdmin(actor, "MANAGE_SUBSCRIPTIONS")
  const row = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: subscriptionInclude,
  })
  if (!row) throw new ApiError("Subscription not found", 404)
  if (row.status === "CANCELED" || row.status === "EXPIRED") {
    throw new ApiError("This subscription is already canceled.", 409)
  }
  const cancelAtPeriodEnd = input.cancelAtPeriodEnd ?? false
  // BIL-001: provider first. Nothing local changes until the
  // provider confirms the cancel (or the row has no provider).
  let providerOutcome: ProviderCancelOutcome | null = null
  if (row.provider && row.providerSubscriptionId) {
    if (!opts.cancelAtProvider) {
      throw new ApiError(
        "This subscription is billed by a provider. Provider cancellation is not available in this context — the subscription was NOT canceled.",
        502
      )
    }
    providerOutcome = await opts.cancelAtProvider(row.provider, {
      providerSubscriptionId: row.providerSubscriptionId,
      cancelAtPeriodEnd,
    })
    if (!providerOutcome.canceledAtProvider) {
      throw new ApiError(
        "The provider did not confirm the cancellation. The subscription was NOT canceled.",
        502
      )
    }
  }
  // A provider that only cancels immediately (PayPal/Freemius) turns
  // a period-end request into an immediate cancel — mirror it
  // locally rather than pretending the period still runs.
  const immediate =
    !cancelAtPeriodEnd ||
    (providerOutcome?.canceledAtProvider && providerOutcome.immediate)
  const updated = immediate
    ? await db.$transaction(async (tx) => {
        const canceled = await tx.subscription.updateMany({
          where: {
            id: subscriptionId,
            status: { notIn: ["CANCELED", "EXPIRED"] },
          },
          data: { status: "CANCELED", cancelAtPeriodEnd: false },
        })
        if (canceled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId,
              type: "CANCELED",
              fromPlanVersionId: row.planVersionId,
              toPlanVersionId: null,
              adminId: actor.user.id,
              reason:
                input.reason ??
                (cancelAtPeriodEnd
                  ? "Canceled immediately — provider has no cancel-at-period-end"
                  : null),
            },
          })
        }
        return tx.subscription.findUniqueOrThrow({
          where: { id: subscriptionId },
          include: subscriptionInclude,
        })
      })
    : await db.$transaction(async (tx) => {
        const scheduled = await tx.subscription.updateMany({
          where: {
            id: subscriptionId,
            status: { notIn: ["CANCELED", "EXPIRED"] },
          },
          data: { cancelAtPeriodEnd: true },
        })
        if (scheduled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId,
              type: "CANCEL_SCHEDULED",
              fromPlanVersionId: row.planVersionId,
              toPlanVersionId: row.planVersionId,
              adminId: actor.user.id,
              reason: input.reason ?? "Cancel scheduled at period end",
            },
          })
        }
        return tx.subscription.findUniqueOrThrow({
          where: { id: subscriptionId },
          include: subscriptionInclude,
        })
      })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CANCEL,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: subscriptionId,
    detail: {
      event: "subscription-canceled",
      cancelAtPeriodEnd: !immediate,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(providerOutcome
        ? {
            provider: row.provider,
            providerSubscriptionId: row.providerSubscriptionId,
            providerCanceled: true,
            providerImmediate: providerOutcome.immediate,
            ...(providerOutcome.note
              ? { providerNote: providerOutcome.note }
              : {}),
          }
        : {}),
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// ─── Customer: subscribe to the Free plan (BIL-120) ──────────────────

// The customer self-service subscribe for free versions only — the
// DSH-403 decision (a). Same one-active-per-user transaction as
// assignSubscription: any previous ACTIVE/TRIALING row is canceled
// with a CANCELED event before the new ACTIVE row is created, so the
// user is never left with two active subscriptions. Paid versions
// refuse with 422 (they go through checkout); subscribing while on a
// different active plan refuses with 409 (cancel that plan first —
// silently replacing a paid plan with Free would drop entitlements);
// subscribing again to the version already held is an idempotent
// no-op returning the existing row.
export async function subscribeToFreePlan(
  userId: string,
  input: SubscribeFreePlanInput
): Promise<SubscriptionSummary> {
  const version = await getVersionOrThrow(input.planVersionId)
  if (version.status !== "PUBLISHED") {
    throw new ApiError(
      "Only a published plan version can be subscribed to.",
      409
    )
  }
  if (version.priceAmount != null && version.priceAmount > 0) {
    throw new ApiError(
      "This plan is not free — subscribe to it through checkout instead.",
      422
    )
  }
  const existing = await findActiveSubscription(userId)
  if (existing) {
    if (existing.planVersionId === version.id) {
      return toSubscriptionSummary(existing)
    }
    throw new ApiError(
      "You already have an active subscription. Cancel it before taking the Free plan.",
      409
    )
  }
  const now = new Date()
  const created = await db.$transaction(async (tx) => {
    const previous = await tx.subscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
      },
      orderBy: { createdAt: "desc" },
    })
    if (previous) {
      const canceled = await tx.subscription.updateMany({
        where: {
          id: previous.id,
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        },
        data: { status: "CANCELED" },
      })
      if (canceled.count === 1) {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: previous.id,
            type: "CANCELED",
            fromPlanVersionId: previous.planVersionId,
            toPlanVersionId: null,
            adminId: null,
            reason: "Replaced by a free-plan subscribe.",
          },
        })
      }
    }
    const next = await tx.subscription.create({
      data: {
        userId,
        planId: version.planId,
        planVersionId: version.id,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: periodEndFor(version.billingInterval, now),
        cancelAtPeriodEnd: false,
      },
    })
    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: next.id,
        type: "CREATED",
        fromPlanVersionId: previous?.planVersionId ?? null,
        toPlanVersionId: version.id,
        adminId: null,
        reason: "Subscribed to the Free plan.",
      },
    })
    return tx.subscription.findUniqueOrThrow({
      where: { id: next.id },
      include: subscriptionInclude,
    })
  })
  await logAudit({
    userId,
    action: AuditAction.ASSIGN,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: created.id,
    detail: {
      event: "subscription-subscribed-free",
      planVersionId: version.id,
    },
  })
  return toSubscriptionSummary(created as SubscriptionWithRelations)
}

// ─── Customer: cancel own subscription (BIL-122 / BIL-091) ─────────────

// The customer cancel path. Ownership is the check: only the caller's
// own latest subscription can be canceled — there is no id in the
// request to confuse with another user's row. The transition mirrors
// cancelSubscription (immediate CANCELED + event, or the
// cancelAtPeriodEnd flag + CANCEL_SCHEDULED event), with the customer
// as the actor.
//
// DSH-402 / BIL-001: a provider-attached subscription is canceled
// at the PROVIDER first (via `opts.cancelAtProvider`). A provider
// failure stops the cancel; a provider row with no callback is a
// hard 502 — the old LOCAL ONLY behavior (cancel the SendCMS row
// and keep billing at the provider) is gone.
export async function cancelMySubscription(
  userId: string,
  input: CancelSubscriptionInput,
  opts: { cancelAtProvider?: ProviderCancelFn } = {}
): Promise<SubscriptionSummary> {
  const row = await db.subscription.findFirst({
    where: { userId },
    include: subscriptionInclude,
    orderBy: { createdAt: "desc" },
  })
  if (!row) throw new ApiError("No subscription found.", 404)
  if (row.status === "CANCELED" || row.status === "EXPIRED") {
    throw new ApiError("This subscription is already canceled.", 409)
  }
  const cancelAtPeriodEnd = input.cancelAtPeriodEnd ?? false
  if (cancelAtPeriodEnd && row.cancelAtPeriodEnd) {
    return toSubscriptionSummary(row as SubscriptionWithRelations)
  }
  let providerOutcome: ProviderCancelOutcome | null = null
  if (row.provider && row.providerSubscriptionId) {
    if (!opts.cancelAtProvider) {
      throw new ApiError(
        "This subscription is billed by a provider. Provider cancellation is not available in this context — the subscription was NOT canceled.",
        502
      )
    }
    providerOutcome = await opts.cancelAtProvider(row.provider, {
      providerSubscriptionId: row.providerSubscriptionId,
      cancelAtPeriodEnd,
    })
    if (!providerOutcome.canceledAtProvider) {
      throw new ApiError(
        "The provider did not confirm the cancellation. The subscription was NOT canceled.",
        502
      )
    }
  }
  const immediate =
    !cancelAtPeriodEnd ||
    (providerOutcome?.canceledAtProvider && providerOutcome.immediate)
  const updated = immediate
    ? await db.$transaction(async (tx) => {
        const canceled = await tx.subscription.updateMany({
          where: {
            id: row.id,
            status: { notIn: ["CANCELED", "EXPIRED"] },
          },
          data: { status: "CANCELED", cancelAtPeriodEnd: false },
        })
        if (canceled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: row.id,
              type: "CANCELED",
              fromPlanVersionId: row.planVersionId,
              toPlanVersionId: null,
              adminId: null,
              reason:
                input.reason ??
                (cancelAtPeriodEnd
                  ? "Canceled immediately — provider has no cancel-at-period-end"
                  : "Canceled by customer."),
            },
          })
        }
        return tx.subscription.findUniqueOrThrow({
          where: { id: row.id },
          include: subscriptionInclude,
        })
      })
    : await db.$transaction(async (tx) => {
        const scheduled = await tx.subscription.updateMany({
          where: {
            id: row.id,
            status: { notIn: ["CANCELED", "EXPIRED"] },
          },
          data: { cancelAtPeriodEnd: true },
        })
        if (scheduled.count === 1) {
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: row.id,
              type: "CANCEL_SCHEDULED",
              fromPlanVersionId: row.planVersionId,
              toPlanVersionId: row.planVersionId,
              adminId: null,
              reason:
                input.reason ?? "Cancel scheduled at period end by customer.",
            },
          })
        }
        return tx.subscription.findUniqueOrThrow({
          where: { id: row.id },
          include: subscriptionInclude,
        })
      })
  await logAudit({
    userId,
    action: AuditAction.CANCEL,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: row.id,
    detail: {
      event: "subscription-canceled-by-customer",
      cancelAtPeriodEnd: !immediate,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(providerOutcome
        ? {
            provider: row.provider,
            providerSubscriptionId: row.providerSubscriptionId,
            providerCanceled: true,
            providerImmediate: providerOutcome.immediate,
            ...(providerOutcome.note
              ? { providerNote: providerOutcome.note }
              : {}),
          }
        : {
            provider: row.provider ?? null,
            providerSubscriptionId: row.providerSubscriptionId ?? null,
          }),
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
}

// ─── Customer: own usage + entitlements (BIL-124 / AIM-014) ─────────────

// The customer usage surface. Owner-scoped by construction: the only
// input is the caller's userId, so no other user's rows can ever be
// returned. This MUST NOT reuse the admin getUsage (SEC-101 — that
// route is admin-only for a reason); the per-meter numbers come from
// checkLimit, the same live counts enforcement uses, so the dashboard
// shows what the quota checks actually see.
export type MyUsageSummary = {
  subscription: SubscriptionSummary | null
  entitlements: PlanEntitlements | null
  source: EffectiveEntitlements["source"]
  planVersionId: string | null
  denied?: string
  emergency: boolean
  meters: Record<UsageMeter, LimitCheck>
}

const MY_USAGE_METERS: UsageMeter[] = [
  "FORMS",
  "DOMAINS",
  "SUBMISSIONS",
  "API_KEYS",
  "MCP_REQUESTS",
  "AI_REQUESTS",
]

export async function getMyUsage(userId: string): Promise<MyUsageSummary> {
  const effective = await getEffectiveEntitlements(userId)
  const [subscription, meterEntries] = await Promise.all([
    getMySubscription(userId),
    Promise.all(
      MY_USAGE_METERS.map(
        async (meter) => [meter, await checkLimit(userId, meter)] as const
      )
    ),
  ])
  return {
    subscription,
    entitlements: effective.entitlements,
    source: effective.source,
    planVersionId: effective.planVersionId,
    ...(effective.denied ? { denied: effective.denied } : {}),
    emergency: effective.emergency,
    meters: Object.fromEntries(meterEntries) as Record<UsageMeter, LimitCheck>,
  }
}

// ─── Entitlements resolution ──────────────────────────────────────────

// Creates the default Free plan (slug "free", published version 1 with
// FREE_PLAN_V1_ENTITLEMENTS) when no plan with that slug exists, so the
// entitlement fallback always resolves. Idempotent under concurrency:
// a unique-slug violation (P2002) means another process created it
// first — re-read instead of failing. Returns null only when the admin
// deliberately ARCHIVED the Free plan; the resolver then falls back to
// the in-memory FREE_PLAN_V1_ENTITLEMENTS instead of resurrecting it.
export async function ensureDefaultFreePlan(): Promise<
  | (Plan & {
      currentVersion: PlanVersion | null
    })
  | null
> {
  const existing = await db.plan.findFirst({
    where: { slug: FREE_PLAN_SLUG },
    include: { currentVersion: true },
  })
  if (existing) {
    if (existing.status === "ARCHIVED") return null
    if (existing.currentVersion) return existing
    // A Free plan exists but has no published version: publish a fresh
    // one (next version number) so the default always resolves. The
    // retry helper covers the concurrent-repair race (DB-028): two
    // first-requests after an archived-then-restored Free plan used to
    // both compute N+1 and one 500d on P2002.
    const version = await createPlanVersionWithRetry(existing.id, () => ({
      planId: existing.id,
      status: "PUBLISHED",
      priceAmount: null,
      priceCurrency: "USD",
      billingInterval: "MONTHLY",
      trialDays: 0,
      entitlements: FREE_PLAN_V1_ENTITLEMENTS,
      changeReason: "Default free plan",
      publishedAt: new Date(),
    }))
    return db.plan.update({
      where: { id: existing.id },
      data: { status: "PUBLISHED", currentVersionId: version.id },
      include: { currentVersion: true },
    })
  }
  try {
    return await db.$transaction(async (tx) => {
      const plan = await tx.plan.create({
        data: {
          name: "Free",
          slug: FREE_PLAN_SLUG,
          description: "The default free plan.",
          kind: "FREE",
          isPrivate: false,
          status: "PUBLISHED",
        },
      })
      const version = await tx.planVersion.create({
        data: {
          planId: plan.id,
          version: 1,
          status: "PUBLISHED",
          priceAmount: null,
          priceCurrency: "USD",
          billingInterval: "MONTHLY",
          trialDays: 0,
          entitlements: FREE_PLAN_V1_ENTITLEMENTS,
          changeReason: "Default free plan",
          publishedAt: new Date(),
        },
      })
      return tx.plan.update({
        where: { id: plan.id },
        data: { currentVersionId: version.id },
        include: { currentVersion: true },
      })
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const raced = await db.plan.findFirst({
        where: { slug: FREE_PLAN_SLUG },
        include: { currentVersion: true },
      })
      if (raced?.currentVersion) return raced
    }
    throw err
  }
}

// The single entitlement resolver, precedence in order:
//   1. Platform emergency restrictions (config/config.json
//      `platform.emergency`): AI + MCP are zeroed for everyone. Forms,
//      domains and submissions are never restricted by this flag.
//   2. Account suspension / explicit denial: a non-ACTIVE user gets
//      null entitlements + denied "suspended".
//   3. Per-user admin overrides (non-expired): per meter, above the
//      subscription's plan version. `value` null = unlimited.
//   4. The active subscription's EFFECTIVE plan version entitlements
//      (never the plan's current version — a plan edit must not change
//      existing customers' terms).
//   5. The default Free plan's published version (or the in-memory
//      FREE_PLAN_V1_ENTITLEMENTS when the Free plan is archived).
// Never throws for a missing plan — the Free plan is always creatable
// (or the in-memory default applies). Throws 404 only for an unknown
// user.
export async function getEffectiveEntitlements(
  userId: string
): Promise<EffectiveEntitlements> {
  const emergency = readPlatformConfig().emergency
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true },
  })
  if (!user) throw new ApiError("User not found", 404)
  // Only an EXPLICIT non-active status denies: a row without a status
  // (a legacy/stale read) is treated as active, not suspended — the
  // status column is NOT NULL with default ACTIVE in production, so a
  // missing value can only come from a partial read, never a real
  // suspended account.
  if (user.status === "SUSPENDED" || user.status === "DISABLED") {
    return {
      entitlements: null,
      source: "free",
      planVersionId: null,
      denied: "suspended",
      emergency,
      overriddenMeters: [],
    }
  }
  const now = new Date()
  const [overrides, subscription] = await Promise.all([
    db.entitlementOverride.findMany({
      where: {
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    findActiveSubscription(userId),
  ])
  let entitlements: PlanEntitlements
  let source: EffectiveEntitlements["source"]
  let planVersionId: string | null
  if (subscription) {
    entitlements = parseEntitlements(subscription.planVersion.entitlements)
    source = "subscription"
    planVersionId = subscription.planVersionId
  } else {
    const free = await ensureDefaultFreePlan()
    if (free?.currentVersion) {
      entitlements = parseEntitlements(free.currentVersion.entitlements)
      planVersionId = free.currentVersion.id
    } else {
      entitlements = FREE_PLAN_V1_ENTITLEMENTS
      planVersionId = null
    }
    source = "free"
  }
  // Precedence 3: overrides apply on top of the base entitlements.
  // `null` means unlimited for the nullable limits; API_KEYS and
  // MCP_REQUESTS are never nullable (setEntitlementOverride rejects a
  // null value for them), so a null there is ignored defensively.
  // SRC-236: an override only counts — in `source` and in
  // `overriddenMeters` — when it actually changes the merged value.
  // A no-op override (same value as the base, or an ignored null)
  // leaves the source as the base plan's, so the admin badge tells
  // the truth about what the user is really on.
  const overriddenMeters: UsageMeter[] = []
  if (overrides.length > 0) {
    const merged: PlanEntitlements = { ...entitlements }
    let changed = false
    for (const override of overrides) {
      switch (override.meter) {
        case "FORMS":
          if (merged.forms !== override.value) {
            merged.forms = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
        case "DOMAINS":
          if (merged.domains !== override.value) {
            merged.domains = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
        case "SUBMISSIONS":
          if (merged.submissionsPerMonth !== override.value) {
            merged.submissionsPerMonth = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
        case "API_KEYS":
          if (override.value !== null && merged.apiKeys !== override.value) {
            merged.apiKeys = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
        case "MCP_REQUESTS":
          if (
            override.value !== null &&
            merged.mcpRequestsPerHour !== override.value
          ) {
            merged.mcpRequestsPerHour = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
        case "AI_REQUESTS":
          if (merged.aiRequestsPerDay !== override.value) {
            merged.aiRequestsPerDay = override.value
            overriddenMeters.push(override.meter)
            changed = true
          }
          break
      }
    }
    entitlements = merged
    if (changed) source = "override"
  }
  // Precedence 1: the emergency switch beats everything, including
  // overrides — AI + MCP are denied, the rest keeps working.
  if (emergency) {
    entitlements = {
      ...entitlements,
      aiRequestsPerDay: 0,
      aiPlatformAllowed: false,
      aiByokAllowed: false,
      mcpRequestsPerMinute: 0,
      mcpRequestsPerHour: 0,
    }
  }
  return {
    entitlements,
    source,
    planVersionId,
    emergency,
    overriddenMeters,
  }
}

// Fail-open wrappers for the enforcement points. The core paths (form
// create, domain register, public submit, MCP, AI rescore) must never
// break because the plans module errored — they call these, get null on
// any failure, and fall back to the platform defaults. SRC-216: this
// fail-open is for READ paths only; creation paths use
// `checkLimitStrict` (fail closed). The failure is logged loudly — a
// silent null here used to disable every quota.
export async function getEffectiveEntitlementsSafe(
  userId: string
): Promise<EffectiveEntitlements | null> {
  try {
    return await getEffectiveEntitlements(userId)
  } catch (err) {
    logger.error(
      "effective entitlements lookup failed, failing open to Free defaults",
      {
        error: err,
        userId,
      }
    )
    return null
  }
}

// ─── Usage metering ───────────────────────────────────────────────────

// DB-050: the ledger write is retried (bounded) instead of failing
// on the first DB blip. The submit path writes its row inside the
// submission transaction (`recordUsageInTransaction` below), so the
// crash window between the submit commit and the ledger write is
// closed there; `reconcileUsageLedger` remains as the backfill for
// rows lost by other paths (AI/MCP usage). A P2002 is still the
// idempotency re-read, not a retry.
const RECORD_USAGE_MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// DB-018: the unit is implied by the meter — it must never drift
// ("forms" vs "form"). The canonical unit per meter lives here, in
// one place; recordUsage refuses any other unit for the meter, so a
// typo'd unit can never reach the ledger. The values are the ones
// the callers already use (SUBMISSIONS "submission", FORMS "form").
export const UNIT_BY_METER: Record<UsageMeter, string> = {
  FORMS: "form",
  DOMAINS: "domain",
  SUBMISSIONS: "submission",
  API_KEYS: "api-key",
  MCP_REQUESTS: "request",
  AI_REQUESTS: "request",
}

export function assertUsageUnit(meter: UsageMeter, unit: string): void {
  if (UNIT_BY_METER[meter] !== unit) {
    throw new ApiError(
      `Invalid unit "${unit}" for meter ${meter} (expected "${UNIT_BY_METER[meter]}").`,
      422
    )
  }
}

function toUsageLedgerData(input: RecordUsageInput) {
  assertUsageUnit(input.meter, input.unit)
  return {
    userId: input.userId,
    meter: input.meter,
    quantity: input.quantity ?? 1,
    unit: input.unit,
    period: new Date(input.period),
    sourceEvent: input.sourceEvent ?? null,
    idempotencyKey: input.idempotencyKey,
    resourceId: input.resourceId ?? null,
  }
}

// Idempotent: a retried operation with the same idempotencyKey returns
// the existing row instead of double-counting (the key is @unique).
export async function recordUsage(input: RecordUsageInput): Promise<UsageRow> {
  const data = toUsageLedgerData(input)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= RECORD_USAGE_MAX_ATTEMPTS; attempt++) {
    try {
      return await db.usageLedger.create({ data })
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await db.usageLedger.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        })
        if (existing) return existing
      }
      lastError = err
      if (attempt < RECORD_USAGE_MAX_ATTEMPTS) {
        logger.warn("usage ledger write failed, retrying", {
          attempt,
          userId: input.userId,
          meter: input.meter,
        })
        await sleep(25 * attempt)
      }
    }
  }
  throw lastError
}

// DB-050: the submission path writes its ledger row inside the
// submission transaction (same tx client), so a crash between the
// submit commit and the ledger write cannot lose the attribution row.
// Single create, no retry — inside a transaction the write either
// commits with the submission or rolls back with it. The idempotency
// key is the submission id, so a duplicate cannot occur for a fresh
// submit. Other callers keep using `recordUsage` (bounded retry).
export async function recordUsageInTransaction(
  tx: Prisma.TransactionClient,
  input: RecordUsageInput
): Promise<UsageRow> {
  return tx.usageLedger.create({ data: toUsageLedgerData(input) })
}

// Summed usage for a user + meter in one period bucket. `period` is the
// bucket start (month start / day start / hour start, UTC).
//
// ADM-033: the ledger total alone under-reports — the ledger is a
// reporting record, never reconciled, while enforcement reads the live
// tables (`getUsedForMeter`). The endpoint therefore reports BOTH
// numbers plus a divergence flag: `liveTotal` is the same live count
// enforcement uses (null when the requested period is not the current
// bucket, so a live count cannot be compared against it), and
// `orphanLedgerRows` counts ledger rows in the bucket whose
// `resourceId` matches no real resource (SUBMISSIONS only — the only
// meter with an orphan check; see `findOrphanUsageRows`).
export async function getUsage(
  actor: AdminSession,
  userId: string,
  meter: UsageMeter | undefined,
  period: Date
): Promise<{
  userId: string
  meter: UsageMeter | null
  period: Date
  total: number
  liveTotal: number | null
  divergent: boolean
  orphanLedgerRows: number
}> {
  // SEC-101: the admin usage endpoint is admin-only — a plain
  // signed-in user must never read another user's usage totals.
  // The capability check lives here (second layer); the route also
  // gates on MANAGE_USAGE before calling (SRC-105).
  requireAdmin(actor, "MANAGE_USAGE")
  const where: Prisma.UsageLedgerWhereInput = { userId, period }
  if (meter) where.meter = meter
  const total = await db.usageLedger.aggregate({
    _sum: { quantity: true },
    where,
  })
  const ledgerTotal = total._sum.quantity ?? 0
  let liveTotal: number | null = null
  if (meter) {
    const now = new Date()
    // Count meters are point-in-time; the period-bound meters only
    // compare against the bucket they are currently in.
    const comparable =
      meter === "FORMS" ||
      meter === "DOMAINS" ||
      meter === "API_KEYS" ||
      (meter === "SUBMISSIONS" &&
        period.getTime() === startOfUtcMonth(now).getTime()) ||
      (meter === "AI_REQUESTS" &&
        period.getTime() === startOfUtcDay(now).getTime()) ||
      (meter === "MCP_REQUESTS" &&
        period.getTime() === startOfUtcHour(now).getTime())
    if (comparable) liveTotal = await getUsedForMeter(userId, meter, now)
  }
  const orphanLedgerRows = meter
    ? (await findOrphanUsageRows(userId, meter, period)).length
    : 0
  return {
    userId,
    meter: meter ?? null,
    period,
    total: ledgerTotal,
    liveTotal,
    divergent: liveTotal !== null && liveTotal !== ledgerTotal,
    orphanLedgerRows,
  }
}

// ADM-033: ledger rows whose `resourceId` names a resource that does
// not exist. Implemented for SUBMISSIONS (the submit path sets
// `resourceId` = the submission id); other meters carry no resource
// reference to check against, so they report none.
export async function findOrphanUsageRows(
  userId: string,
  meter: UsageMeter,
  period: Date
): Promise<{ id: string; resourceId: string; createdAt: Date }[]> {
  if (meter !== "SUBMISSIONS") return []
  const rows =
    (await db.usageLedger.findMany({
      where: {
        userId,
        meter,
        period,
        resourceId: { not: null },
      },
      select: { id: true, resourceId: true, createdAt: true },
    })) ?? []
  const resourceIds = rows
    .map((row) => row.resourceId)
    .filter((id): id is string => id !== null)
  if (resourceIds.length === 0) return []
  const live =
    (await db.submission.findMany({
      where: { id: { in: resourceIds } },
      select: { id: true },
    })) ?? []
  const liveIds = new Set(live.map((row) => row.id))
  return rows
    .filter((row) => row.resourceId !== null && !liveIds.has(row.resourceId))
    .map((row) => ({
      id: row.id,
      resourceId: row.resourceId as string,
      createdAt: row.createdAt,
    }))
}

// DB-050: reconcile the SUBMISSIONS ledger against the live
// Submission table for one user + month. A submission written by the
// submit path with no ledger row (crash or DB blip between the
// submission commit and the best-effort `recordUsage` call) gets its
// row backfilled with the same idempotency key the submit path uses
// (the submission id), so a later retry can never double-count.
// Returns what was checked, backfilled, and how many orphan ledger
// rows the bucket still holds. AI/MCP usage has no source table to
// reconcile against here — their best-effort writers live in the
// ai-settings / mcp packages.
export async function reconcileUsageLedger(
  userId: string,
  period: Date = startOfUtcMonth()
): Promise<{ checked: number; backfilled: number; orphans: number }> {
  const monthStart = startOfUtcMonth(period)
  const nextMonth = new Date(monthStart)
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  const [submissions, ledgerRows] = await Promise.all([
    db.submission.findMany({
      where: {
        ownerId: userId,
        createdAt: { gte: monthStart, lt: nextMonth },
      },
      select: { id: true, createdAt: true },
    }),
    db.usageLedger.findMany({
      where: { userId, meter: "SUBMISSIONS", period: monthStart },
      select: { idempotencyKey: true },
    }),
  ])
  const submissionList = submissions ?? []
  const recorded = new Set((ledgerRows ?? []).map((row) => row.idempotencyKey))
  let backfilled = 0
  for (const submission of submissionList) {
    if (recorded.has(submission.id)) continue
    await recordUsage({
      userId,
      meter: "SUBMISSIONS",
      quantity: 1,
      unit: "submission",
      period: startOfUtcMonth(submission.createdAt).toISOString(),
      sourceEvent: "submission:created",
      idempotencyKey: submission.id,
      resourceId: submission.id,
    })
    backfilled++
  }
  const orphans = (await findOrphanUsageRows(userId, "SUBMISSIONS", monthStart))
    .length
  return { checked: submissionList.length, backfilled, orphans }
}

// How much of a meter the user has used in the current period. Count
// meters (forms / domains / API keys) read the LIVE count — never the
// ledger, which is a reporting record, not the source of truth for
// how many resources exist. SUBMISSIONS counts the Submission table in
// the current calendar month (same reason). AI_REQUESTS sums the
// AiDailyUsage counters across the user's forms for today. MCP_REQUESTS
// sums the current-hour ApiKeyRateLimit counters across the user's keys.
async function getUsedForMeter(
  userId: string,
  meter: UsageMeter,
  at: Date = new Date()
): Promise<number> {
  if (meter === "FORMS") {
    return db.form.count({ where: { ownerId: userId } })
  }
  if (meter === "DOMAINS") {
    return db.domain.count({ where: { ownerId: userId } })
  }
  if (meter === "API_KEYS") {
    return db.apiKey.count({ where: { userId, revokedAt: null } })
  }
  if (meter === "SUBMISSIONS") {
    // PRF-011 (Phase 16, Wave 3): the monthly quota count filters on
    // the denormalized Submission.ownerId — served by
    // @@index([ownerId, createdAt]) — instead of joining Form. This
    // runs on the public submit path, so the index path matters.
    return db.submission.count({
      where: {
        ownerId: userId,
        createdAt: { gte: startOfUtcMonth(at) },
      },
    })
  }
  if (meter === "AI_REQUESTS") {
    const forms = await db.form.findMany({
      where: { ownerId: userId },
      select: { id: true },
    })
    // Wave 8 (AIM-028): the daily budget is ONE budget — the worker
    // rescore counts per form (AiDailyUsage) AND the interactive
    // paths count per owner (AiDailyOwnerUsage). Both sums count
    // here, or the allowance shown to the user would undercount
    // interactive spend.
    const [formUsage, ownerUsage] = await Promise.all([
      forms.length === 0
        ? Promise.resolve({ _sum: { calls: null } })
        : db.aiDailyUsage.aggregate({
            _sum: { calls: true },
            where: {
              formId: { in: forms.map((f) => f.id) },
              date: startOfUtcDay(at),
            },
          }),
      db.aiDailyOwnerUsage.aggregate({
        _sum: { calls: true },
        where: { userId, date: startOfUtcDay(at) },
      }),
    ])
    return (formUsage._sum.calls ?? 0) + (ownerUsage._sum.calls ?? 0)
  }
  // MCP_REQUESTS: the current hour's counted calls across the user's keys.
  const keys = await db.apiKey.findMany({
    where: { userId },
    select: { id: true },
  })
  if (keys.length === 0) return 0
  const total = await db.apiKeyRateLimit.aggregate({
    _sum: { hourCount: true },
    where: {
      apiKeyId: { in: keys.map((k) => k.id) },
      hourWindowStart: startOfUtcHour(at),
    },
  })
  return total._sum.hourCount ?? 0
}

export async function checkLimit(
  userId: string,
  meter: UsageMeter
): Promise<LimitCheck> {
  const effective = await getEffectiveEntitlements(userId)
  if (!effective.entitlements) {
    return { allowed: false, limit: 0, used: 0, remaining: 0 }
  }
  const limit = effective.entitlements[METER_LIMIT_KEY[meter]]
  const used = await getUsedForMeter(userId, meter)
  if (limit === null) {
    return { allowed: true, limit: null, used, remaining: null }
  }
  return {
    allowed: used < limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
  }
}

// SRC-216: "no limit configured" and "the lookup failed" must not
// be the same value. `checkLimit` returning a limit of `null` means
// "unlimited by the plan"; a failed lookup is a `LimitCheckError`.
// Creation paths use `checkLimitStrict` (fail CLOSED — a plans-module
// error refuses the creation with 503 rather than silently granting
// unlimited resources). Read paths keep `checkLimitSafe` (fail open),
// but the failure is logged loudly so silent over-provisioning is
// visible.
export class LimitCheckError extends ApiError {
  constructor(
    message = "The plan limit could not be checked. Please try again.",
    cause?: unknown
  ) {
    super(message, 503)
    this.name = "LimitCheckError"
    this.cause = cause
  }
}

export async function checkLimitStrict(
  userId: string,
  meter: UsageMeter
): Promise<LimitCheck> {
  try {
    return await checkLimit(userId, meter)
  } catch (err) {
    logger.error("limit check failed, creation refused (fail-closed)", {
      error: err,
      userId,
      meter,
    })
    throw new LimitCheckError(undefined, err)
  }
}

export async function checkLimitSafe(
  userId: string,
  meter: UsageMeter
): Promise<LimitCheck | null> {
  try {
    return await checkLimit(userId, meter)
  } catch (err) {
    // FAIL-OPEN, LOUD: read paths keep working, but a failed lookup
    // must never silently disable quotas — this line is the signal.
    logger.error(
      "limit check failed, failing open: quotas are NOT enforced for this call",
      { error: err, userId, meter }
    )
    return null
  }
}

// Check + record in one step: when the quota is exhausted nothing is
// recorded and `allowed` is false. The check-then-record window is the
// same pre-insert guard the codebase already uses for form/domain/key
// creation — the ledger is the audit trail, and the hard enforcement
// points re-check the live count at creation time.
export async function consumeQuota(
  userId: string,
  input: {
    meter: UsageMeter
    quantity?: number
    unit: string
    sourceEvent?: string
    idempotencyKey: string
    resourceId?: string
  }
): Promise<LimitCheck & { recorded: boolean; usageId: string | null }> {
  const check = await checkLimit(userId, input.meter)
  if (!check.allowed) return { ...check, recorded: false, usageId: null }
  const quantity = input.quantity ?? 1
  const row = await recordUsage({
    userId,
    meter: input.meter,
    quantity,
    unit: input.unit,
    period: periodStartForMeter(input.meter).toISOString(),
    sourceEvent: input.sourceEvent,
    idempotencyKey: input.idempotencyKey,
    resourceId: input.resourceId,
  })
  return {
    allowed: true,
    limit: check.limit,
    used: check.used + quantity,
    remaining:
      check.limit === null
        ? null
        : Math.max(0, check.limit - check.used - quantity),
    recorded: true,
    usageId: row.id,
  }
}

// ─── Entitlement overrides ────────────────────────────────────────────

export async function listEntitlementOverrides(
  actor: AdminSession,
  filters: EntitlementOverrideListQuery
): Promise<{
  overrides: EntitlementOverrideRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "MANAGE_USAGE")
  const { userId, meter, page, perPage } = filters
  const where: Prisma.EntitlementOverrideWhereInput = {}
  if (userId) where.userId = userId
  if (meter) where.meter = meter
  const [total, rows] = await Promise.all([
    db.entitlementOverride.count({ where }),
    db.entitlementOverride.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        admin: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    overrides: rows,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

// Upsert by [userId, meter]: one override per meter per user. The
// reason is required — overrides are audited with it.
export async function setEntitlementOverride(
  actor: AdminSession,
  userId: string,
  input: SetEntitlementOverrideInput
): Promise<EntitlementOverrideRow> {
  requireAdmin(actor, "MANAGE_USAGE")
  // API_KEYS and MCP_REQUESTS are never unlimited: an unbounded key
  // count is an abuse vector, and the MCP limiter always needs a
  // number. A null override for them is rejected (the admin sets a
  // number instead).
  if (
    input.value === null &&
    (input.meter === "API_KEYS" || input.meter === "MCP_REQUESTS")
  ) {
    throw new ApiError(
      "The API key and MCP request limits cannot be unlimited.",
      400
    )
  }
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const row = await db.entitlementOverride.upsert({
    where: { userId_meter: { userId, meter: input.meter } },
    create: {
      userId,
      meter: input.meter,
      value: input.value,
      reason: input.reason,
      adminId: actor.user.id,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
    update: {
      value: input.value,
      reason: input.reason,
      adminId: actor.user.id,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
      admin: { select: { id: true, name: true, email: true } },
    },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.ENTITLEMENT,
    resourceId: row.id,
    detail: {
      event: "entitlement-override-set",
      userId,
      meter: input.meter,
      value: input.value,
      reason: input.reason,
    },
  })
  return row
}

// Deleting the override row removes the override — the audit log keeps
// the history (who set it, when, why).
export async function removeEntitlementOverride(
  actor: AdminSession,
  userId: string,
  meter: UsageMeter
): Promise<{ deleted: boolean }> {
  requireAdmin(actor, "MANAGE_USAGE")
  const existing = await db.entitlementOverride.findUnique({
    where: { userId_meter: { userId, meter } },
  })
  if (!existing) return { deleted: false }
  await db.entitlementOverride.delete({ where: { id: existing.id } })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.ENTITLEMENT,
    resourceId: existing.id,
    detail: { event: "entitlement-override-removed", userId, meter },
  })
  return { deleted: true }
}
