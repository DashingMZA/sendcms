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
export function periodEndFor(
  interval: BillingInterval,
  start: Date
): Date | null {
  const end = new Date(start)
  if (interval === "MONTHLY") {
    end.setUTCMonth(end.getUTCMonth() + 1)
    return end
  }
  if (interval === "ANNUAL") {
    end.setUTCFullYear(end.getUTCFullYear() + 1)
    return end
  }
  return null
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
  const { q, status, kind, page, perPage, sort } = filters
  const where: Prisma.PlanWhereInput = {}
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
    ]
  }
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
  const published = await db.$transaction(async (tx) => {
    if (plan.currentVersionId) {
      await tx.planVersion.update({
        where: { id: plan.currentVersionId },
        data: { status: "SUPERSEDED" },
      })
    }
    const updated = await tx.planVersion.update({
      where: { id: versionId },
      data: { status: "PUBLISHED", publishedAt: now },
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
  const { userId, planId, status, page, perPage, sort } = filters
  const where: Prisma.SubscriptionWhereInput = {}
  if (userId) where.userId = userId
  if (planId) where.planId = planId
  if (status) where.status = status
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
// version + parsed entitlements — the read the admin UI's Package tab
// and the entitlement resolver share. Null when the user has no
// subscription (they fall back to the default Free plan).
export async function getUserSubscription(
  actor: AdminSession,
  userId: string
): Promise<(SubscriptionSummary & { entitlements: PlanEntitlements }) | null> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const row = await findActiveSubscription(userId)
  if (!row) return null
  return {
    ...toSubscriptionSummary(row),
    entitlements: parseEntitlements(row.planVersion.entitlements),
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
  userId: string
): Promise<SubscriptionWithRelations | null> {
  const row = await db.subscription.findFirst({
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
  const created = await db.$transaction(async (tx) => {
    const previous = await tx.subscription.findFirst({
      where: {
        userId: input.userId,
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      orderBy: { createdAt: "desc" },
    })
    if (previous) {
      await tx.subscription.update({
        where: { id: previous.id },
        data: { status: "CANCELED" },
      })
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
}

// Activate (or re-activate) a subscription from a verified checkout
// webhook. Same one-active-per-user transaction as
// assignSubscription: the previous ACTIVE/TRIALING subscription is
// canceled, the new one is created ACTIVE on the webhook's plan
// version with the provider subscription id stored. Idempotent per
// provider subscription: a repeated delivery for the same provider
// subscription id returns the existing row instead of creating a
// second subscription.
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
  const created = await db.$transaction(async (tx) => {
    // BIL-090: the duplicate guard is atomic — a transaction-scoped
    // advisory lock on (provider, providerSubscriptionId) serializes
    // concurrent deliveries of the same checkout event, so two
    // deliveries cannot both pass the `findFirst` below and create two
    // ACTIVE subscriptions. (No unique index on
    // providerSubscriptionId exists — schema changes are out of scope
    // for this fix — so the lock, plus the BillingEvent guard in the
    // webhook handler, is the serialization point.)
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.provider}:${input.providerSubscriptionId}`}))`
    )
    const duplicate = await tx.subscription.findFirst({
      where: {
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
        status: { in: ["ACTIVE", "TRIALING"] },
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
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      orderBy: { createdAt: "desc" },
    })
    if (previous) {
      await tx.subscription.update({
        where: { id: previous.id },
        data: { status: "CANCELED" },
      })
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: previous.id,
          type: "CANCELED",
          fromPlanVersionId: previous.planVersionId,
          toPlanVersionId: null,
          adminId: null,
          reason: `Superseded by checkout via ${input.provider}`,
        },
      })
    }
    const next = await tx.subscription.create({
      data: {
        userId: input.userId,
        planId: version.planId,
        planVersionId: version.id,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd:
          input.periodEnd ?? periodEndFor(version.billingInterval, now),
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
        reason: `Checkout completed via ${input.provider}`,
      },
    })
    return tx.subscription.findUniqueOrThrow({
      where: { id: next.id },
      include: subscriptionInclude,
    })
  })
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
  if (!existing) return null
  const updated = await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: existing.id },
      data: { status: "CANCELED" },
    })
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
// transaction as the update, and revives a PAST_DUE subscription
// back to ACTIVE.
export async function extendSubscriptionPeriod(
  provider: BillingProvider,
  providerSubscriptionId: string,
  periodEnd: Date | null
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

// BIL-080: mark the subscription behind a provider subscription id
// PAST_DUE after a failed renewal payment. Entitlements survive
// through the grace window (see `isSubscriptionPeriodLive`); the
// expiry job flips it to EXPIRED once the grace ends, and a
// successful renewal revives it via `extendSubscriptionPeriod`.
// Returns null when nothing matches — a payment failure for a
// subscription SendCMS never activated is not an error. No
// SubscriptionEvent is written: the event enum has no PAST_DUE type;
// the audit row is the record.
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
  const updated = await db.subscription.update({
    where: { id: existing.id },
    data: { status: "PAST_DUE" },
    include: subscriptionInclude,
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
  let subscriptions: (SubscriptionWithRelations & {
    user: { id: string; name: string | null; email: string }
  })[]
  let skippedUserIds: string[] = []
  if (input.allOnVersionId) {
    const rows = await db.subscription.findMany({
      where: {
        planVersionId: input.allOnVersionId,
        status: { in: ["ACTIVE", "TRIALING"] },
      },
      include: subscriptionInclude,
      orderBy: { createdAt: "asc" },
      take: 101,
    })
    subscriptions = rows as never
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
    subscriptions = rows as never
  }

  // Users already on the target version are not affected.
  const affected = subscriptions.filter(
    (row) => row.planVersionId !== input.planVersionId
  )
  skippedUserIds = [
    ...skippedUserIds,
    ...subscriptions
      .filter((row) => row.planVersionId === input.planVersionId)
      .map((row) => row.userId),
  ]
  const previewTruncated = affected.length > 100
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
  return {
    targetPlanVersionId: target.id,
    targetPlan,
    affectedCount: affected.length,
    users,
    previewTruncated,
    skippedUserIds,
  }
}

// Executes a migration for EXACTLY the selected userIds — never the
// whole plan, never unselected subscriptions. Each subscription's
// version change + its MIGRATED event happen in one transaction, so a
// version change is never recorded without its event. Rollback is a
// new migration back to the previous version — history is never
// rewritten.
export async function executeMigration(
  actor: AdminSession,
  input: ExecuteMigrationInput
): Promise<{
  migratedUserIds: string[]
  skippedUserIds: string[]
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
  for (const userId of userIds) {
    const current = await findActiveSubscription(userId)
    if (!current || current.planVersionId === input.planVersionId) {
      skippedUserIds.push(userId)
      continue
    }
    await db.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: current.id },
        data: { planId: target.planId, planVersionId: target.id },
      })
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
    })
    migratedUserIds.push(userId)
  }
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
      reason: input.reason,
    },
  })
  return {
    migratedUserIds,
    skippedUserIds,
    count: migratedUserIds.length,
  }
}

// Cancels a subscription. With `cancelAtPeriodEnd` the subscription
// stays ACTIVE until its period ends (the flag is the record — the
// actual expiry is a later job's concern); otherwise it is canceled
// immediately with a CANCELED event.
export async function cancelSubscription(
  actor: AdminSession,
  subscriptionId: string,
  input: CancelSubscriptionInput
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
  const updated = input.cancelAtPeriodEnd
    ? await db.subscription.update({
        where: { id: subscriptionId },
        data: { cancelAtPeriodEnd: true },
        include: subscriptionInclude,
      })
    : await db.$transaction(async (tx) => {
        const canceled = await tx.subscription.update({
          where: { id: subscriptionId },
          data: { status: "CANCELED", cancelAtPeriodEnd: false },
          include: subscriptionInclude,
        })
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId,
            type: "CANCELED",
            fromPlanVersionId: row.planVersionId,
            toPlanVersionId: null,
            adminId: actor.user.id,
            reason: input.reason ?? null,
          },
        })
        return canceled
      })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CANCEL,
    resourceType: AuditResource.SUBSCRIPTION,
    resourceId: subscriptionId,
    detail: {
      event: "subscription-canceled",
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return toSubscriptionSummary(updated as SubscriptionWithRelations)
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

function toUsageLedgerData(input: RecordUsageInput) {
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
    if (forms.length === 0) return 0
    const total = await db.aiDailyUsage.aggregate({
      _sum: { calls: true },
      where: {
        formId: { in: forms.map((f) => f.id) },
        date: startOfUtcDay(at),
      },
    })
    return total._sum.calls ?? 0
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
