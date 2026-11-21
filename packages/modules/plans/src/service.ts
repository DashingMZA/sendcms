import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, Prisma, db } from "@sendcms/database"
import type {
  AdminRole,
  BillingInterval,
  Plan,
  PlanKind,
  PlanStatus,
  PlanVersion,
  PlanVersionStatus,
  PlatformRole,
  SubscriptionEventType,
  SubscriptionStatus,
  UsageMeter,
} from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import { adminCan, type PlatformCapability } from "@sendcms/permissions"
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

// The actor's effective role: the platform owner outranks everything,
// a staff adminRole comes next, and everyone else is a plain user.
function getEffectiveRole(session: AdminSession): PlatformRole | AdminRole {
  if (session.user.platformRole === "PLATFORM_OWNER") return "PLATFORM_OWNER"
  return session.user.adminRole ?? "PLATFORM_USER"
}

// Throws 403 unless the actor holds the capability.
export function requireAdmin(
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

export function readPlatformConfig(): PlatformConfig {
  if (platformConfigCache) return platformConfigCache
  let emergency = false
  try {
    const root = findWorkspaceRoot(process.cwd())
    if (root) {
      const raw = readFileSync(join(root, "config", "config.json"), "utf8")
      const parsed = JSON.parse(raw) as {
        platform?: { emergency?: unknown }
      }
      emergency = parsed.platform?.emergency === true
    }
  } catch {
    emergency = false
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

// The subscription's period end for a billing interval. CUSTOM and
// ONE_TIME have no automatic period (the admin sets dates, or none).
function periodEndFor(interval: BillingInterval, start: Date): Date | null {
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
  const version = await db.planVersion.create({
    data: {
      planId,
      version: await nextVersionNumber(planId),
      status: "DRAFT",
      priceAmount: input.priceAmount ?? null,
      priceCurrency: input.priceCurrency ?? "USD",
      billingInterval: input.billingInterval ?? "MONTHLY",
      trialDays: input.trialDays ?? 0,
      entitlements,
      changeReason: input.changeReason ?? null,
      createdById: actor.user.id,
    },
    include: { plan: { select: { name: true } } },
  })
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

// The user's ACTIVE or TRIALING subscription (latest first). One active
// subscription per user is enforced in the service (assign cancels the
// old one before creating the new one) — a DB partial unique index is
// not expressible in Prisma schema.
async function findActiveSubscription(
  userId: string
): Promise<SubscriptionWithRelations | null> {
  const row = await db.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "TRIALING"] } },
    include: subscriptionInclude,
    orderBy: { createdAt: "desc" },
  })
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
    // one (next version number) so the default always resolves.
    const version = await db.planVersion.create({
      data: {
        planId: existing.id,
        version: await nextVersionNumber(existing.id),
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
  const overriddenMeters: UsageMeter[] = []
  if (overrides.length > 0) {
    const merged: PlanEntitlements = { ...entitlements }
    for (const override of overrides) {
      switch (override.meter) {
        case "FORMS":
          merged.forms = override.value
          break
        case "DOMAINS":
          merged.domains = override.value
          break
        case "SUBMISSIONS":
          merged.submissionsPerMonth = override.value
          break
        case "API_KEYS":
          if (override.value !== null) merged.apiKeys = override.value
          break
        case "MCP_REQUESTS":
          if (override.value !== null)
            merged.mcpRequestsPerHour = override.value
          break
        case "AI_REQUESTS":
          merged.aiRequestsPerDay = override.value
          break
      }
      overriddenMeters.push(override.meter)
    }
    entitlements = merged
    source = "override"
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
// any failure, and fall back to the platform defaults.
export async function getEffectiveEntitlementsSafe(
  userId: string
): Promise<EffectiveEntitlements | null> {
  try {
    return await getEffectiveEntitlements(userId)
  } catch (err) {
    logger.error("effective entitlements lookup failed", {
      error: err,
      userId,
    })
    return null
  }
}

// ─── Usage metering ───────────────────────────────────────────────────

// Idempotent: a retried operation with the same idempotencyKey returns
// the existing row instead of double-counting (the key is @unique).
export async function recordUsage(input: RecordUsageInput): Promise<UsageRow> {
  const data = {
    userId: input.userId,
    meter: input.meter,
    quantity: input.quantity ?? 1,
    unit: input.unit,
    period: new Date(input.period),
    sourceEvent: input.sourceEvent ?? null,
    idempotencyKey: input.idempotencyKey,
    resourceId: input.resourceId ?? null,
  }
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
    throw err
  }
}

// Summed usage for a user + meter in one period bucket. `period` is the
// bucket start (month start / day start / hour start, UTC).
export async function getUsage(
  userId: string,
  meter: UsageMeter | undefined,
  period: Date
): Promise<{
  userId: string
  meter: UsageMeter | null
  period: Date
  total: number
}> {
  const where: Prisma.UsageLedgerWhereInput = { userId, period }
  if (meter) where.meter = meter
  const total = await db.usageLedger.aggregate({
    _sum: { quantity: true },
    where,
  })
  return {
    userId,
    meter: meter ?? null,
    period,
    total: total._sum.quantity ?? 0,
  }
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
    return db.submission.count({
      where: {
        form: { ownerId: userId },
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

export async function checkLimitSafe(
  userId: string,
  meter: UsageMeter
): Promise<LimitCheck | null> {
  try {
    return await checkLimit(userId, meter)
  } catch (err) {
    logger.error("limit check failed", { error: err, userId, meter })
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
