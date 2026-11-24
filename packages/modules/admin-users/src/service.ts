import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, db } from "@sendcms/database"
import type {
  AdminRole,
  PlatformRole,
  Prisma,
  UserStatus,
} from "@sendcms/database"
import { adminCan, type PlatformCapability } from "@sendcms/permissions"
import { logAudit, requireStepUp } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type { AdminUserListQuery } from "./validators"

// Admin user management (Phase 3) — the admin app's backend for
// inspecting and acting on customer accounts. Framework-independent
// (no Next.js imports); only services import @sendcms/database.
//
// Authorization lives HERE, not in the routes: every function takes the
// actor's AdminSession first and enforces its capability before touching
// any data. The UI is never the security boundary.

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

// ─── Email sending ────────────────────────────────────────────────────

// The service never imports Better Auth (or any mailer) itself: the
// route layer injects a sender built from `betterAuth.api`, so the
// verification / reset email is REALLY sent — never just a flag flip.
// If the send throws, the service propagates the error and nothing is
// half-applied (requireEmailVerification sends BEFORE flipping the flag).
export type AdminEmailSender = {
  sendVerificationEmail: (email: string) => Promise<void>
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

// The target user for an admin action, with the fields the guards need.
async function getTargetUserOrThrow(userId: string) {
  const target = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      platformRole: true,
      status: true,
      adminRole: true,
      email: true,
      emailVerified: true,
    },
  })
  if (!target) throw new ApiError("User not found", 404)
  return target
}

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
    }),
    db.domain.findMany({
      where: { ownerId: userId },
      select: { id: true, domain: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
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
  const [updated] = await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        status: "SUSPENDED",
        statusReason: input.reason,
        statusChangedAt: now,
      },
      select: statusSelect,
    }),
    db.session.deleteMany({ where: { userId } }),
  ])
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
  const updated = await db.user.update({
    where: { id: userId },
    data: { status: "ACTIVE", statusReason: null, statusChangedAt: now },
    select: statusSelect,
  })
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
  const [updated] = await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        status: "DISABLED",
        statusReason: input.reason,
        statusChangedAt: now,
      },
      select: statusSelect,
    }),
    db.session.deleteMany({ where: { userId } }),
  ])
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
  const updated = await db.user.update({
    where: { id: userId },
    data: { status: "ACTIVE", statusReason: null, statusChangedAt: now },
    select: statusSelect,
  })
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
  // Send FIRST: if the mail fails, nothing changes and the admin sees
  // the error instead of a silently unverified user with no email.
  await sender.sendVerificationEmail(target.email)
  const updated = await db.user.update({
    where: { id: userId },
    data: { emailVerified: false },
    select: { id: true, emailVerified: true },
  })
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
  return db.adminNote.create({
    data: { userId, adminId: actor.user.id, body: input.body },
    include: {
      admin: { select: { id: true, name: true, email: true } },
    },
  })
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
  const [domains, forms, submissions, apiKeys, auditEvents] = await Promise.all(
    [
      db.domain.findMany({
        where: { ownerId: userId },
        select: { id: true, domain: true, status: true },
      }),
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
      }),
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
      }),
      db.apiKey.findMany({
        where: { userId },
        select: { prefix: true, last4: true, scope: true, revokedAt: true },
      }),
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
    ]
  )
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
      count: submissions.length,
      items: submissions.map((row) => ({
        id: row.id,
        formId: row.formId,
        formName: row.form.name,
        status: row.status,
        createdAt: row.createdAt,
        originDomain: row.originDomain,
      })),
    },
    apiKeys,
    auditEvents,
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
  await getTargetUserOrThrow(userId)
  const open = await db.deletionRequest.findFirst({
    where: { userId, status: { in: ["REQUESTED", "APPROVED"] } },
    select: { id: true },
  })
  if (open) {
    throw new ApiError("A deletion request is already open for this user.", 409)
  }
  const now = new Date()
  const [updated, request] = await db.$transaction([
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
