import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, Prisma, db } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import { logAudit } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  CreateFlagInput,
  DeleteFlagInput,
  SetFlagInput,
  SetFlagOverrideInput,
} from "./validators"
import {
  getTargetUserOrThrow,
  requireAdmin,
  type AuditOpts,
} from "./require-admin"

// Feature flags (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes.
//
// The flags are DB-backed (NOT config/config.json) so an admin can
// flip them from /admin/features with no restart and no redeploy.
// The Phase 4 platform emergency flag in config/config.json stays
// the separate restart-gated kill-switch — it is not a flag in this
// registry and it is not toggled from here.
//
// Precedence: per-user override → global flag → default (off). An
// unknown key is OFF — fail-closed. Three features read flags:
// `ai-spam-rescore` guards submission re-scoring, `ai-digest`
// guards the digest job, and `registration` (read by
// `isRegistrationEnabled` in @sendcms/auth, not via this module)
// gates new sign-ups; an unknown or disabled flag keeps its job
// off. (ADM-091: the old note claiming no feature read a flag was
// stale since Phase 8 wired those two gates.)

const logger = createLogger("platform-ops:flags")

// ADM-092: the built-in system flags guard live jobs
// (`ai-spam-rescore` guards rescoreNewSubmissions, `ai-digest`
// guards sendDueDigests). Deleting one would silently disable its
// job, so deleteFlag refuses them with a 422 — disable the flag
// instead. The UI hides the delete button for these keys.
// DOC-003: `registration` joins them — deleting it would silently
// close registration, because an unknown key is fail-closed OFF.
export const SYSTEM_FLAGS = [
  "ai-spam-rescore",
  "ai-digest",
  "registration",
] as const

export type SystemFlagKey = (typeof SYSTEM_FLAGS)[number]

export function isSystemFlag(key: string): key is SystemFlagKey {
  return (SYSTEM_FLAGS as readonly string[]).includes(key)
}

export type FeatureFlagRow = {
  key: string
  name: string
  description: string | null
  isEnabled: boolean
  createdAt: Date
  updatedAt: Date
  /** ADM-098: per-user override count — set by listFlags (one
      groupBy), not by getFlag. Absent means "not computed". */
  overrideCount?: number
}

function toFlagRow(row: {
  key: string
  name: string
  description: string | null
  isEnabled: boolean
  createdAt: Date
  updatedAt: Date
}): FeatureFlagRow {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type FeatureFlagOverrideRow = {
  flagKey: string
  userId: string
  user: { id: string; name: string | null; email: string } | null
  isEnabled: boolean
  reason: string
  adminId: string | null
  createdAt: Date
  updatedAt: Date
}

async function getFlagOrThrow(key: string) {
  const flag = await db.featureFlag.findUnique({ where: { key } })
  if (!flag) throw new ApiError(`Feature flag "${key}" not found.`, 404)
  return flag
}

/** One flag by key. MANAGE_FEATURE_FLAGS. */
export async function getFlag(
  actor: AdminSession,
  key: string
): Promise<FeatureFlagRow> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const flag = await getFlagOrThrow(key)
  return toFlagRow(flag)
}

/** Every flag, newest first. Reads and writes both need
    MANAGE_FEATURE_FLAGS — the flags page is a management page, and
    the role map keeps it owner + SUPER_ADMIN only.
    ADM-098: the per-flag override count rides along in the same
    response (one groupBy on featureFlagOverride, joined on flagId),
    so the overview no longer fires one useFlagOverrides query per
    row. */
export async function listFlags(
  actor: AdminSession
): Promise<{ flags: FeatureFlagRow[] }> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const [flags, counts] = await Promise.all([
    db.featureFlag.findMany({
      orderBy: { createdAt: "desc" },
    }),
    db.featureFlagOverride.groupBy({
      by: ["flagId"],
      _count: { _all: true },
    }),
  ])
  const overrideCount = new Map(counts.map((c) => [c.flagId, c._count._all]))
  return {
    flags: flags.map((flag) => ({
      ...toFlagRow(flag),
      overrideCount: overrideCount.get(flag.id) ?? 0,
    })),
  }
}

/** Creates a flag (off by default). MANAGE_FEATURE_FLAGS, audited.
    A duplicate key is a 409, never an upsert. */
export async function createFlag(
  actor: AdminSession,
  input: CreateFlagInput,
  opts: AuditOpts = {}
): Promise<FeatureFlagRow> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const existing = await db.featureFlag.findUnique({
    where: { key: input.key },
    select: { key: true },
  })
  if (existing) {
    throw new ApiError(`Feature flag "${input.key}" already exists.`, 409)
  }
  // SRC-206: the pre-check is not enough — a concurrent duplicate
  // key surfaces as P2002, which is a 409, never a 500.
  let flag
  try {
    flag = await db.featureFlag.create({
      data: {
        key: input.key,
        name: input.name,
        description: input.description ?? null,
      },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(`Feature flag "${input.key}" already exists.`, 409)
    }
    throw err
  }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.CREATE,
    resourceType: AuditResource.FEATURE_FLAG,
    resourceId: flag.key,
    detail: { event: "flag-created", name: flag.name },
    correlationId: opts.correlationId,
  })
  return toFlagRow(flag)
}

/** Flips the global switch. MANAGE_FEATURE_FLAGS, reason required,
    audited with the old/new values. */
export async function setFlag(
  actor: AdminSession,
  key: string,
  input: SetFlagInput,
  opts: AuditOpts = {}
): Promise<FeatureFlagRow> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  await getFlagOrThrow(key)
  // DB-051: the "before" value is read under a row lock in the same
  // transaction as the write, so a concurrent toggle cannot make the
  // audit's old value stale (the read-then-write it replaced could
  // record a transition that never happened).
  const { oldIsEnabled, updated } = await db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ isEnabled: boolean }[]>`
      SELECT "isEnabled" FROM "FeatureFlag" WHERE "key" = ${key} FOR UPDATE
    `
      if (locked.length === 0) {
        throw new ApiError(`Feature flag "${key}" not found.`, 404)
      }
      const updated = await tx.featureFlag.update({
        where: { key },
        data: { isEnabled: input.isEnabled },
      })
      return { oldIsEnabled: locked[0].isEnabled, updated }
    },
    // Prisma's interactive-transaction defaults (maxWait 2s) are too
    // tight when two toggles race: the loser waits on the row lock
    // AND on a pool connection (max 5), so the 2s start window can
    // expire before it gets its turn (seen live against the dev DB).
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FEATURE_FLAG,
    resourceId: key,
    detail: {
      event: "flag-toggled",
      reason: input.reason,
      oldIsEnabled,
      newIsEnabled: updated.isEnabled,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  return toFlagRow(updated)
}

/** Deletes a flag and its per-user overrides in ONE transaction.
    MANAGE_FEATURE_FLAGS, reason required, audited with the number
    of overrides removed. 404 when the flag does not exist.
    ADM-092: built-in system flags (SYSTEM_FLAGS) are refused with
    a 422 — deleting one would silently disable the live job it
    guards; disable the flag instead. */
export async function deleteFlag(
  actor: AdminSession,
  key: string,
  input: DeleteFlagInput,
  opts: AuditOpts = {}
): Promise<{ deleted: true; key: string; overridesRemoved: number }> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  if (isSystemFlag(key)) {
    throw new ApiError(
      `Built-in flag "${key}" cannot be deleted — it guards a live job. Disable it instead.`,
      422
    )
  }
  const flag = await getFlagOrThrow(key)
  const { overridesRemoved, flagsRemoved } = await db.$transaction(
    async (tx) => {
      const overrides = await tx.featureFlagOverride.deleteMany({
        where: { flagId: flag.id },
      })
      // deleteMany (not delete): a concurrent delete surfaces as a
      // zero count, which becomes the same 404 — never a raw P2025.
      const flags = await tx.featureFlag.deleteMany({
        where: { key },
      })
      return {
        overridesRemoved: overrides.count,
        flagsRemoved: flags.count,
      }
    }
  )
  if (flagsRemoved !== 1) {
    throw new ApiError(`Feature flag "${key}" not found.`, 404)
  }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.FEATURE_FLAG,
    resourceId: key,
    detail: {
      event: "flag-deleted",
      reason: input.reason,
      overridesRemoved,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  return { deleted: true as const, key, overridesRemoved }
}

// ─── Per-user overrides ───────────────────────────────────────────────

function toOverrideRow(
  flagKey: string,
  row: {
    userId: string
    user: { id: string; name: string | null; email: string } | null
    isEnabled: boolean
    reason: string
    adminId: string | null
    createdAt: Date
    updatedAt: Date
  }
): FeatureFlagOverrideRow {
  return { flagKey, ...row }
}

/** Every per-user override for one flag. MANAGE_FEATURE_FLAGS. */
export async function listFlagOverrides(
  actor: AdminSession,
  key: string
): Promise<{ overrides: FeatureFlagOverrideRow[] }> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const flag = await getFlagOrThrow(key)
  const rows = await db.featureFlagOverride.findMany({
    where: { flagId: flag.id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  })
  return { overrides: rows.map((r) => toOverrideRow(key, r)) }
}

/** Sets (or replaces) one user's override. MANAGE_FEATURE_FLAGS,
    reason required, audited with the old/new values. A user with an
    override is unaffected by the global toggle. */
export async function setFlagOverride(
  actor: AdminSession,
  key: string,
  userId: string,
  input: SetFlagOverrideInput,
  opts: AuditOpts = {}
): Promise<FeatureFlagOverrideRow> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const flag = await getFlagOrThrow(key)
  await getTargetUserOrThrow(userId)
  // DB-051: the override's "before" value is read in the same
  // transaction as the upsert, while the parent flag row is locked —
  // overrides for one flag serialize on that lock, so a concurrent
  // override write cannot make the audit's old value stale.
  const { before, updated } = await db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "FeatureFlag" WHERE "key" = ${key} FOR UPDATE
    `
      if (locked.length === 0) {
        throw new ApiError(`Feature flag "${key}" not found.`, 404)
      }
      const before = await tx.featureFlagOverride.findUnique({
        where: { flagId_userId: { flagId: flag.id, userId } },
      })
      const updated = await tx.featureFlagOverride.upsert({
        where: { flagId_userId: { flagId: flag.id, userId } },
        update: {
          isEnabled: input.isEnabled,
          reason: input.reason,
          adminId: actor.user.id,
        },
        create: {
          flagId: flag.id,
          userId,
          isEnabled: input.isEnabled,
          reason: input.reason,
          adminId: actor.user.id,
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      })
      return { before, updated }
    },
    // Same headroom as setFlag (see above): the loser of a race on
    // one flag's lock needs more than Prisma's 2s default start window.
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FEATURE_FLAG,
    resourceId: key,
    detail: {
      event: "flag-override-set",
      reason: input.reason,
      targetUserId: userId,
      oldIsEnabled: before?.isEnabled ?? null,
      newIsEnabled: updated.isEnabled,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  return toOverrideRow(key, updated)
}

/** Removes one user's override (the global flag applies again).
    MANAGE_FEATURE_FLAGS, audited. 404 when no override exists. */
export async function removeFlagOverride(
  actor: AdminSession,
  key: string,
  userId: string,
  opts: AuditOpts = {}
): Promise<{ removed: true; flagKey: string; userId: string }> {
  requireAdmin(actor, "MANAGE_FEATURE_FLAGS")
  const flag = await getFlagOrThrow(key)
  const existing = await db.featureFlagOverride.findUnique({
    where: { flagId_userId: { flagId: flag.id, userId } },
  })
  if (!existing) {
    throw new ApiError(
      `No override exists for this user on flag "${key}".`,
      404
    )
  }
  await db.featureFlagOverride.delete({
    where: { flagId_userId: { flagId: flag.id, userId } },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.FEATURE_FLAG,
    resourceId: key,
    detail: {
      event: "flag-override-removed",
      targetUserId: userId,
      oldIsEnabled: existing.isEnabled,
    },
    correlationId: opts.correlationId,
  })
  return { removed: true as const, flagKey: key, userId }
}

// ─── Evaluation ───────────────────────────────────────────────────────

/** Reads one flag for one user: per-user override → global flag →
    default (off). An unknown key is OFF — fail-closed. Never throws:
    on a DB error it returns false and logs, so a flag lookup can
    never break the request that asked. No actor, no capability —
    this is the read path features call, not an admin action. */
export async function isFeatureEnabled(
  key: string,
  userId?: string
): Promise<boolean> {
  try {
    const flag = await db.featureFlag.findUnique({
      where: { key },
      select: { id: true, isEnabled: true },
    })
    if (!flag) return false
    if (userId) {
      const override = await db.featureFlagOverride.findUnique({
        where: { flagId_userId: { flagId: flag.id, userId } },
        select: { isEnabled: true },
      })
      if (override) return override.isEnabled
    }
    return flag.isEnabled
  } catch (err) {
    logger.warn("feature flag lookup failed, defaulting to off", {
      error: err,
      key,
    })
    return false
  }
}
