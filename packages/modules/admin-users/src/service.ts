import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, db, Prisma } from "@sendcms/database"
import type { AdminRole, PlatformRole, UserStatus } from "@sendcms/database"
import { getEffectiveRole, requireAdmin } from "@sendcms/permissions"
import { getTargetUserOrThrow } from "@sendcms/permissions/target-user"
import { logAudit, requireStepUp } from "@sendcms/security"
import { enqueueAccountApprovedEmail } from "@sendcms/notifications"
import { ApiError } from "@sendcms/shared"
import { createLogger } from "@sendcms/observability"
import type { AdminUserListQuery } from "./validators"

// Admin user management (Phase 3) — the admin app's backend for
// inspecting and acting on customer accounts. Framework-independent
// (no Next.js imports); only services import @sendcms/database.
//
// Authorization lives HERE, not in the routes: every function takes the
// actor's AdminSession first and enforces its capability before touching
// any data. The UI is never the security boundary.

// ─── Authorization ────────────────────────────────────────────────────

const logger = createLogger("admin-users")

// The admin gate lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module, re-exported
// here so existing import paths keep working. `getTargetUserOrThrow`
// is the shared lookup from the same home.
export { getEffectiveRole, requireAdmin } from "@sendcms/permissions"

// ─── Email sending ────────────────────────────────────────────────────

// The service never imports Better Auth (or any mailer) itself: the
// route layer injects a sender built from the auth instance, so the
// verification / reset email is REALLY sent — never just a flag flip.
// DB-052 (Phase 16, Wave 9): requireEmailVerification flips the flag
// FIRST, then sends. The old order (send first) left the opposite
// half-apply: mail sent, flag unchanged, no record, when the update
// threw after a successful send. On a send failure now, the flag
// stays flipped (the account genuinely must re-verify) and the
// failure is recorded durably in the audit log + the server log, so
// the state is recoverable — the admin re-sends from the user detail
// page instead of the user sitting verified-with-a-verify-mail.
export type AdminEmailSender = {
  // ADM-001: the verification send takes the target's identity, not
  // just the address — the sender mints the token for that user
  // directly (no admin session involved; see
  // apps/api/lib/admin-email-sender.ts).
  sendVerificationEmail: (input: {
    email: string
    name?: string | null
    userId?: string
  }) => Promise<void>
  sendPasswordReset: (email: string) => Promise<void>
}

// ─── Shapes ───────────────────────────────────────────────────────────

// The fields a user list may show. No password/token/keyHash lives on
// the User row, and the explicit select keeps it that way.
const userSummarySelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  platformRole: true,
  adminRole: true,
  status: true,
  statusReason: true,
  createdAt: true,
  deletionRequestedAt: true,
} as const

export type AdminUserSummary = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  platformRole: PlatformRole
  adminRole: AdminRole | null
  status: UserStatus
  statusReason: string | null
  createdAt: Date
  deletionRequestedAt: Date | null
  counts: {
    forms: number
    domains: number
    submissions: number
    apiKeys: number
  }
}

export type AdminUserDetail = {
  profile: Omit<AdminUserSummary, "counts"> & {
    locale: string | null
    updatedAt: Date
    statusChangedAt: Date | null
  }
  counts: AdminUserSummary["counts"]
  forms: { id: string; name: string; aiEnabled: boolean; createdAt: Date }[]
  domains: { id: string; domain: string; status: string; createdAt: Date }[]
  apiKeys: {
    id: string
    name: string
    prefix: string
    last4: string
    scope: string
    revokedAt: Date | null
    lastUsedAt: Date | null
    createdAt: Date
  }[]
  notes: AdminNoteWithAdmin[]
  auditEvents: AuditEventWithActor[]
}

export type AdminNoteWithAdmin = {
  id: string
  userId: string
  adminId: string | null
  body: string
  createdAt: Date
  updatedAt: Date
  admin: { id: string; name: string; email: string } | null
}

export type AuditEventWithActor = {
  id: string
  action: string
  resourceType: string
  resourceId: string
  detail: unknown
  createdAt: Date
  userId: string | null
  user: { id: string; name: string; email: string } | null
}

export type AdminUserSubmissionMeta = {
  id: string
  formId: string
  formName: string
  status: string
  createdAt: Date
  originDomain: string
}

// ─── Helpers ──────────────────────────────────────────────────────────

// Submission counts per user, in two queries (no N+1): the users' forms,
// then submissions grouped by form.
async function getSubmissionCounts(
  userIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(userIds.map((id) => [id, 0]))
  const forms = await db.form.findMany({
    where: { ownerId: { in: userIds } },
    select: { id: true, ownerId: true },
  })
  if (forms.length === 0) return counts
  const ownerByForm = new Map(forms.map((f) => [f.id, f.ownerId]))
  const grouped = await db.submission.groupBy({
    by: ["formId"],
    _count: { _all: true },
    where: { formId: { in: forms.map((f) => f.id) } },
  })
  for (const row of grouped) {
    const ownerId = ownerByForm.get(row.formId)
    if (ownerId)
      counts.set(ownerId, (counts.get(ownerId) ?? 0) + row._count._all)
  }
  return counts
}

// The target user for an admin action is looked up by the shared
// helper from `@sendcms/permissions/target-user` (imported above) —
// it selects the fields the guards need (platformRole, email, …).

// The platform owner account can never be suspended, disabled, or have
// its staff role changed.
function forbidOwnerTarget(
  target: { platformRole: PlatformRole },
  action: string
): void {
  if (target.platformRole === "PLATFORM_OWNER") {
    throw new ApiError(`The platform owner account cannot be ${action}.`, 403)
  }
}

// An admin can never act on their own account through these routes.
function forbidSelfTarget(
  actor: AdminSession,
  targetId: string,
  action: string
): void {
  if (actor.user.id === targetId) {
    throw new ApiError(`You cannot ${action} your own account.`, 403)
  }
}

function toSummary(
  row: {
    id: string
    name: string
    email: string
    emailVerified: boolean
    platformRole: PlatformRole
    adminRole: AdminRole | null
    status: UserStatus
    statusReason: string | null
    createdAt: Date
    deletionRequestedAt: Date | null
    _count: { forms: number; domains: number; apiKeys: number }
  },
  submissionCount: number
): AdminUserSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    platformRole: row.platformRole,
    adminRole: row.adminRole,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: row.createdAt,
    deletionRequestedAt: row.deletionRequestedAt,
    counts: {
      forms: row._count.forms,
      domains: row._count.domains,
      submissions: submissionCount,
      apiKeys: row._count.apiKeys,
    },
  }
}

// ─── Reads ────────────────────────────────────────────────────────────

export async function listUsers(
  actor: AdminSession,
  filters: AdminUserListQuery
): Promise<{
  users: AdminUserSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_USERS")
  const { q, status, adminRole, emailVerified, page, perPage, sort } = filters
  const where: Prisma.UserWhereInput = {}
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ]
  }
  if (status) where.status = status
  // "NONE" = no staff role (adminRole IS NULL) — plain customers.
  if (adminRole === "NONE") where.adminRole = null
  else if (adminRole) where.adminRole = adminRole
  if (emailVerified !== undefined) where.emailVerified = emailVerified
  const [field = "createdAt", direction = "desc"] = sort.split(":")
  const orderBy: Prisma.UserOrderByWithRelationInput = {
    [field]: direction === "asc" ? "asc" : "desc",
  }
  const [total, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      select: {
        ...userSummarySelect,
        _count: { select: { forms: true, domains: true, apiKeys: true } },
      },
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  const submissionCounts = await getSubmissionCounts(rows.map((r) => r.id))
  return {
    users: rows.map((row) => toSummary(row, submissionCounts.get(row.id) ?? 0)),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

export async function getUserDetail(
  actor: AdminSession,
  userId: string
): Promise<AdminUserDetail> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      ...userSummarySelect,
      locale: true,
      updatedAt: true,
      statusChangedAt: true,
      _count: { select: { forms: true, domains: true, apiKeys: true } },
    },
  })
  if (!user) throw new ApiError("User not found", 404)
  const [forms, domains, apiKeys, notes, auditEvents] = await Promise.all([
    db.form.findMany({
      where: { ownerId: userId },
      select: { id: true, name: true, aiEnabled: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      // PRF-015: the detail page shows the newest 20, like the
      // notes/audit lists below — the full lists were unbounded.
      take: 20,
    }),
    db.domain.findMany({
      where: { ownerId: userId },
      select: { id: true, domain: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        prefix: true,
        last4: true,
        scope: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.adminNote.findMany({
      where: { userId },
      include: {
        admin: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.auditLog.findMany({
      where: { OR: [{ resourceId: userId }, { userId }] },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ])
  const submissionCounts = await getSubmissionCounts([userId])
  const summary = toSummary(user, submissionCounts.get(userId) ?? 0)
  return {
    profile: {
      id: summary.id,
      name: summary.name,
      email: summary.email,
      emailVerified: summary.emailVerified,
      platformRole: summary.platformRole,
      adminRole: summary.adminRole,
      status: summary.status,
      statusReason: summary.statusReason,
      createdAt: summary.createdAt,
      deletionRequestedAt: summary.deletionRequestedAt,
      locale: user.locale,
      updatedAt: user.updatedAt,
      statusChangedAt: user.statusChangedAt,
    },
    counts: summary.counts,
    forms,
    domains,
    apiKeys,
    notes,
    auditEvents,
  }
}

// Submission METADATA only — never the `data` JSON. Full content needs
// getUserSubmission (VIEW_SENSITIVE_SUBMISSIONS + access logging).
export async function listUserSubmissions(
  actor: AdminSession,
  userId: string,
  { page, perPage }: { page: number; perPage: number }
): Promise<{
  submissions: AdminUserSubmissionMeta[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!target) throw new ApiError("User not found", 404)
  const where: Prisma.SubmissionWhereInput = { form: { ownerId: userId } }
  const [total, rows] = await Promise.all([
    db.submission.count({ where }),
    db.submission.findMany({
      where,
      select: {
        id: true,
        formId: true,
        status: true,
        createdAt: true,
        originDomain: true,
        form: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    submissions: rows.map((row) => ({
      id: row.id,
      formId: row.formId,
      formName: row.form.name,
      status: row.status,
      createdAt: row.createdAt,
      originDomain: row.originDomain,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  }
}

// Full submission including `data`. Requires VIEW_SENSITIVE_SUBMISSIONS
// and logs the access BEFORE the content leaves the server. 404 when the
// submission does not belong to the user.
export async function getUserSubmission(
  actor: AdminSession,
  userId: string,
  submissionId: string
) {
  requireAdmin(actor, "VIEW_SENSITIVE_SUBMISSIONS")
  const submission = await db.submission.findFirst({
    where: { id: submissionId, form: { ownerId: userId } },
    include: { form: { select: { id: true, name: true } } },
  })
  if (!submission) throw new ApiError("Submission not found", 404)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.SUBMISSION,
    resourceId: submission.id,
    detail: { event: "sensitive-submission-access", userId },
  })
  return submission
}

// ─── Status actions ───────────────────────────────────────────────────

const statusSelect = {
  id: true,
  status: true,
  statusReason: true,
  statusChangedAt: true,
} as const

// DB-027: the atomic status transition every status action funnels
// through. The update is conditional on the row still holding the
// expected status, so two mutually exclusive actions racing on the
// same user cannot both apply: the loser's update matches zero rows
// and gets a 409, and its audit row is never written (the audit
// happens after this returns). The session wipe (suspend/disable)
// rides in the same transaction as the status write, so a lost race
// cannot wipe sessions for an action that did not apply. The
// pre-read guards in each caller stay — they give the friendly
// "already suspended" / "only a suspended user" messages; this is
// the enforcement underneath them.
async function transitionUserStatus(
  userId: string,
  expectedStatus: UserStatus,
  data: Prisma.UserUpdateManyMutationInput,
  wipeSessions: boolean
) {
  return db.$transaction(
    async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: userId, status: expectedStatus },
        data,
      })
      if (result.count !== 1) {
        throw new ApiError(
          "This user's status changed while the request was in flight. Please reload and try again.",
          409
        )
      }
      if (wipeSessions) {
        await tx.session.deleteMany({ where: { userId } })
      }
      const row = await tx.user.findUnique({
        where: { id: userId },
        select: statusSelect,
      })
      if (!row) throw new ApiError("User not found", 404)
      return row
    },
    // Same headroom as the flag toggles (platform-ops/src/flags.ts):
    // the loser of a race on one user's row needs more than Prisma's
    // 2s default start window.
    { maxWait: 20000, timeout: 30000 }
  )
}

export async function suspendUser(
  actor: AdminSession,
  userId: string,
  input: { reason: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  // The reason is required (also enforced by the Zod schema at the
  // route) — a suspension without a recorded reason is not auditable.
  if (!input.reason.trim()) {
    throw new ApiError("Reason is required", 400)
  }
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "suspended")
  forbidSelfTarget(actor, userId, "suspend")
  if (target.status === "SUSPENDED") {
    throw new ApiError("This user is already suspended.", 409)
  }
  if (target.status === "DISABLED") {
    throw new ApiError(
      "This user is disabled. Restore the account before suspending it.",
      409
    )
  }
  const now = new Date()
  // Status change + session wipe in one transaction: suspension locks
  // the account out immediately (auth() also rejects non-ACTIVE users).
  const updated = await transitionUserStatus(
    userId,
    "ACTIVE",
    {
      status: "SUSPENDED",
      statusReason: input.reason,
      statusChangedAt: now,
    },
    true
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.SUSPEND,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "user-suspended", reason: input.reason },
  })
  return updated
}

export async function reactivateUser(
  actor: AdminSession,
  userId: string,
  input: { reason?: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  const target = await getTargetUserOrThrow(userId)
  if (target.status !== "SUSPENDED") {
    throw new ApiError("Only a suspended user can be reactivated.", 409)
  }
  const now = new Date()
  const updated = await transitionUserStatus(
    userId,
    "SUSPENDED",
    { status: "ACTIVE", statusReason: null, statusChangedAt: now },
    false
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.REACTIVATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "user-reactivated",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return updated
}

export async function disableUser(
  actor: AdminSession,
  userId: string,
  input: { reason: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  if (!input.reason.trim()) {
    throw new ApiError("Reason is required", 400)
  }
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "disabled")
  forbidSelfTarget(actor, userId, "disable")
  if (target.status === "SUSPENDED") {
    throw new ApiError(
      "This user is suspended. Reactivate the account before disabling it.",
      409
    )
  }
  if (target.status === "DISABLED") {
    throw new ApiError("This user is already disabled.", 409)
  }
  // Step-up (Phase 9): disabling an account is high-impact — the
  // actor re-enters their password first. Checked last, after every
  // cheap guard, immediately before the write.
  await requireStepUp(actor)
  const now = new Date()
  const updated = await transitionUserStatus(
    userId,
    "ACTIVE",
    {
      status: "DISABLED",
      statusReason: input.reason,
      statusChangedAt: now,
    },
    true
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "user-disabled", reason: input.reason },
  })
  return updated
}

export async function restoreUser(
  actor: AdminSession,
  userId: string,
  input: { reason?: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  const target = await getTargetUserOrThrow(userId)
  if (target.status !== "DISABLED") {
    throw new ApiError("Only a disabled user can be restored.", 409)
  }
  const now = new Date()
  const updated = await transitionUserStatus(
    userId,
    "DISABLED",
    { status: "ACTIVE", statusReason: null, statusChangedAt: now },
    false
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "user-restored",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return updated
}

// DOC-003: approve / reject mirror `suspendUser` (D8), minus step-up
// (D10 — both are reversible, so no `requireStepUp` here). No session
// wipe in either: a pending user holds no session.
export async function approveUser(
  actor: AdminSession,
  userId: string,
  input: { reason?: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "approved")
  forbidSelfTarget(actor, userId, "approve")
  // A rejected user is DISABLED with the rejection reason on the row —
  // they come back via `restoreUser`, never via approve.
  if (target.status === "DISABLED" && target.statusReason) {
    throw new ApiError(
      "This user was rejected. Restore the account instead of approving it.",
      409
    )
  }
  if (target.status !== "PENDING_APPROVAL") {
    throw new ApiError("Only a user awaiting approval can be approved.", 409)
  }
  const now = new Date()
  const updated = await transitionUserStatus(
    userId,
    "PENDING_APPROVAL",
    { status: "ACTIVE", statusReason: null, statusChangedAt: now },
    false
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "user-approved",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  // Best-effort, AFTER the status write + audit: a mail failure never
  // rolls back an approval (the outbox retry covers it).
  try {
    const localeRow = await db.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    })
    await enqueueAccountApprovedEmail({
      userId,
      to: target.email,
      name: target.name,
      locale: localeRow?.locale ?? undefined,
    })
  } catch (err) {
    logger.error("approval email enqueue failed after approval", {
      error: err,
      userId,
    })
  }
  return updated
}

export async function rejectUser(
  actor: AdminSession,
  userId: string,
  input: { reason: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  // The reason is required (also enforced by the Zod schema at the
  // route) — a rejection without a recorded reason is not auditable.
  if (!input.reason.trim()) {
    throw new ApiError("Reason is required", 400)
  }
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "rejected")
  forbidSelfTarget(actor, userId, "reject")
  if (target.status !== "PENDING_APPROVAL") {
    throw new ApiError("Only a user awaiting approval can be rejected.", 409)
  }
  const now = new Date()
  const updated = await transitionUserStatus(
    userId,
    "PENDING_APPROVAL",
    {
      status: "DISABLED",
      statusReason: input.reason,
      statusChangedAt: now,
    },
    false
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "user-rejected", reason: input.reason },
  })
  return updated
}

// ─── Role, keys, sessions ─────────────────────────────────────────────

export async function setAdminRole(
  actor: AdminSession,
  userId: string,
  input: { adminRole: AdminRole | null }
) {
  requireAdmin(actor, "MANAGE_USERS")
  // MANAGER holds MANAGE_USERS but may not change any admin role — only
  // the platform owner and Super Admin can. (SUPER_ADMIN still cannot
  // grant MANAGE_ADMINISTRATORS: that capability stays owner-only in the
  // role map, and role assignment itself never grants it.)
  if (getEffectiveRole(actor) === "MANAGER") {
    throw new ApiError(
      "Only the platform owner and Super Admin can change admin roles.",
      403
    )
  }
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "assigned a staff role")
  forbidSelfTarget(actor, userId, "change the admin role of")
  // Step-up (Phase 9): changing a staff role is high-impact — the
  // actor re-enters their password first. Checked last, after every
  // cheap guard, immediately before the write.
  await requireStepUp(actor)
  // DB-051: the previous role is read under a row lock in the same
  // transaction as the write, so a concurrent role change cannot make
  // the audit's "from" value stale.
  const { previousAdminRole, updated } = await db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<
        {
          adminRole: AdminRole | null
        }[]
      >`
        SELECT "adminRole" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `
      if (locked.length === 0) {
        throw new ApiError("User not found.", 404)
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { adminRole: input.adminRole },
        select: { id: true, adminRole: true },
      })
      return { previousAdminRole: locked[0].adminRole, updated }
    },
    // Same headroom as the flag toggles (platform-ops/src/flags.ts):
    // the loser of a race on one user's row lock needs more than
    // Prisma's 2s default start window.
    { maxWait: 20000, timeout: 30000 }
  )
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "admin-role-changed",
      from: previousAdminRole,
      to: input.adminRole,
    },
  })
  return {
    id: updated.id,
    adminRole: updated.adminRole,
    previousAdminRole,
  }
}

export async function revokeUserApiKeys(actor: AdminSession, userId: string) {
  requireAdmin(actor, "MANAGE_USERS")
  // SEC-103 / ADM-009: revoking all of a user's API keys is a
  // destructive, account-wide action — it requires a fresh step-up
  // verification like the single MCP-key revoke, and the proof is
  // consumed, so one password entry revokes one user's keys.
  await requireStepUp(actor)
  await getTargetUserOrThrow(userId)
  const result = await db.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "api-keys-revoked", count: result.count },
  })
  return { count: result.count }
}

export async function revokeUserSessions(actor: AdminSession, userId: string) {
  requireAdmin(actor, "MANAGE_USERS")
  await getTargetUserOrThrow(userId)
  forbidSelfTarget(actor, userId, "revoke the sessions of")
  const result = await db.session.deleteMany({ where: { userId } })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "sessions-revoked" },
  })
  return { count: result.count }
}

// ─── Email actions ────────────────────────────────────────────────────

export async function requireEmailVerification(
  actor: AdminSession,
  userId: string,
  sender: AdminEmailSender
) {
  requireAdmin(actor, "MANAGE_USERS")
  const target = await getTargetUserOrThrow(userId)
  // DB-052: flip the flag FIRST, then send. If the send fails, the
  // flag stays flipped and the failure is recorded durably (audit
  // marker below) + loudly (server log) — the state is recoverable:
  // the admin can re-send, and the account never reads as verified
  // while holding an unverified-mail.
  const updated = await db.user.update({
    where: { id: userId },
    data: { emailVerified: false },
    select: { id: true, emailVerified: true },
  })
  try {
    await sender.sendVerificationEmail({
      email: target.email,
      name: target.name,
      userId: target.id,
    })
  } catch (err) {
    // Loud + durable: the mail failed AFTER the flag flipped, so
    // this is the record that makes the state recoverable. The error
    // still propagates — the admin must see the send failed.
    logger.error("verification email failed after emailVerified flip", {
      error: err,
      userId,
      targetEmail: target.email,
    })
    await logAudit({
      userId: actor.user.id,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.USER,
      resourceId: userId,
      detail: {
        event: "email-verification-required-send-failed",
        error: err instanceof Error ? err.message : "unknown error",
      },
    })
    throw err
  }
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "email-verification-required" },
  })
  return updated
}

export async function triggerPasswordReset(
  actor: AdminSession,
  userId: string,
  sender: AdminEmailSender
) {
  requireAdmin(actor, "MANAGE_USERS")
  const target = await getTargetUserOrThrow(userId)
  await sender.sendPasswordReset(target.email)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "password-reset-triggered" },
  })
  return { id: target.id, email: target.email }
}

// ─── Notes ────────────────────────────────────────────────────────────

export async function addAdminNote(
  actor: AdminSession,
  userId: string,
  input: { body: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  if (!input.body.trim()) {
    throw new ApiError("Note is required", 400)
  }
  await getTargetUserOrThrow(userId)
  const note = await db.adminNote.create({
    data: { userId, adminId: actor.user.id, body: input.body },
    include: {
      admin: { select: { id: true, name: true, email: true } },
    },
  })
  // ADM-010: a note is part of the account's admin history, so its
  // creation is audited like every sibling action — the note body
  // itself never goes in the audit detail.
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "admin-note-added", noteId: note.id },
  })
  return note
}

export async function listAdminNotes(
  actor: AdminSession,
  userId: string,
  { page, perPage }: { page: number; perPage: number }
): Promise<{
  notes: AdminNoteWithAdmin[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_USERS")
  await getTargetUserOrThrow(userId)
  const [total, notes] = await Promise.all([
    db.adminNote.count({ where: { userId } }),
    db.adminNote.findMany({
      where: { userId },
      include: {
        admin: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return { notes, total, page, perPage, totalPages: Math.ceil(total / perPage) }
}

// ─── Export & deletion ────────────────────────────────────────────────

// SRC-209: at most this many rows per export section (newest first).
// The audit-events section keeps its own smaller cap (50) below.
export const USER_DATA_EXPORT_MAX_ROWS = 1000

// Safe fields ONLY: no password, no tokens, no keyHash, no submission
// `data`. The export itself is audited.
export async function exportUserData(actor: AdminSession, userId: string) {
  requireAdmin(actor, "VIEW_CUSTOMER_DATA")
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      platformRole: true,
      adminRole: true,
      status: true,
      locale: true,
      createdAt: true,
    },
  })
  if (!user) throw new ApiError("User not found", 404)
  // SRC-209: every section is capped at USER_DATA_EXPORT_MAX_ROWS
  // (newest first) with a matching total, so a user with a huge
  // history cannot OOM the export the way the old unbounded
  // submission/domain/form/apiKey loads could. `submissions.count`
  // is now the TOTAL (was the returned length — identical while
  // under the cap); `truncated` says whether any section was cut.
  const [
    domains,
    domainTotal,
    forms,
    formTotal,
    submissions,
    submissionTotal,
    apiKeys,
    apiKeyTotal,
    auditEvents,
    auditEventTotal,
  ] = await Promise.all([
    db.domain.findMany({
      where: { ownerId: userId },
      select: { id: true, domain: true, status: true },
      orderBy: { createdAt: "desc" },
      take: USER_DATA_EXPORT_MAX_ROWS,
    }),
    db.domain.count({ where: { ownerId: userId } }),
    db.form.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        name: true,
        fields: {
          select: { name: true, type: true, required: true },
          orderBy: { order: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: USER_DATA_EXPORT_MAX_ROWS,
    }),
    db.form.count({ where: { ownerId: userId } }),
    db.submission.findMany({
      where: { form: { ownerId: userId } },
      select: {
        id: true,
        formId: true,
        status: true,
        createdAt: true,
        originDomain: true,
        form: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: USER_DATA_EXPORT_MAX_ROWS,
    }),
    db.submission.count({ where: { form: { ownerId: userId } } }),
    db.apiKey.findMany({
      where: { userId },
      select: { prefix: true, last4: true, scope: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
      take: USER_DATA_EXPORT_MAX_ROWS,
    }),
    db.apiKey.count({ where: { userId } }),
    db.auditLog.findMany({
      where: { OR: [{ resourceId: userId }, { userId }] },
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        detail: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.auditLog.count({
      where: { OR: [{ resourceId: userId }, { userId }] },
    }),
  ])
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: { event: "user-data-exported" },
  })
  return {
    profile: user,
    domains,
    forms: forms.map((form) => ({
      id: form.id,
      name: form.name,
      fields: form.fields,
    })),
    submissions: {
      count: submissionTotal,
      items: submissions.map((row) => ({
        id: row.id,
        formId: row.formId,
        formName: row.form.name,
        status: row.status,
        createdAt: row.createdAt,
        originDomain: row.originDomain,
      })),
      truncated: submissionTotal > submissions.length,
      limit: USER_DATA_EXPORT_MAX_ROWS,
    },
    apiKeys,
    auditEvents,
    // True when any section was cut at its cap, so the downloader can
    // say so instead of silently handing over a partial export.
    truncated:
      domainTotal > domains.length ||
      formTotal > forms.length ||
      submissionTotal > submissions.length ||
      apiKeyTotal > apiKeys.length ||
      auditEventTotal > auditEvents.length,
    limit: USER_DATA_EXPORT_MAX_ROWS,
  }
}

// Records the request only — no data is deleted here. The actual
// erasure workflow is Phase 7: this also creates the DeletionRequest
// row the workflow reviews (REQUESTED → APPROVED → COMPLETED), in the
// same transaction as the user flag, so the two can never disagree.
// At most one open (REQUESTED/APPROVED) request per user.
export async function requestDeletion(
  actor: AdminSession,
  userId: string,
  input: { reason: string }
) {
  requireAdmin(actor, "MANAGE_USERS")
  if (!input.reason.trim()) {
    throw new ApiError("Reason is required", 400)
  }
  // ADM-002: the owner/self guards every sibling action has — the
  // platform owner can never be deleted, and no admin can request
  // deletion of their own account.
  const target = await getTargetUserOrThrow(userId)
  forbidOwnerTarget(target, "deleted")
  forbidSelfTarget(actor, userId, "request deletion of")
  const open = await db.deletionRequest.findFirst({
    where: { userId, status: { in: ["REQUESTED", "APPROVED"] } },
    select: { id: true },
  })
  if (open) {
    throw new ApiError("A deletion request is already open for this user.", 409)
  }
  const now = new Date()
  // SRC-210: the one-open-request check above is a pre-check only —
  // two concurrent requests could both pass it. The partial unique
  // index `DeletionRequest_one_open_idx` (raw migration
  // 20261124131329, Prisma cannot express a partial unique index)
  // makes the create atomic; a P2002 here means the other request
  // won, so it becomes the same friendly 409.
  const [updated, request] = await db
    .$transaction([
      db.user.update({
        where: { id: userId },
        data: { deletionRequestedAt: now, deletionRequestReason: input.reason },
        select: {
          id: true,
          deletionRequestedAt: true,
          deletionRequestReason: true,
        },
      }),
      db.deletionRequest.create({
        data: { userId, reason: input.reason },
      }),
    ])
    .catch((err: unknown) => {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ApiError(
          "A deletion request is already open for this user.",
          409
        )
      }
      throw err
    })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.USER,
    resourceId: userId,
    detail: {
      event: "deletion-requested",
      reason: input.reason,
      deletionRequestId: request.id,
    },
  })
  // The caller (and the Phase 7 deletion workflow) needs the workflow
  // row's id, not just the user flag.
  return { ...updated, deletionRequestId: request.id }
}
