import type { AdminSession } from "@sendcms/auth"
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
  Prisma,
  db,
} from "@sendcms/database"
import { logAudit, requireStepUp } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  ExecuteErasureInput,
  ReviewDeletionRequestInput,
} from "./validators"
import { requireAdmin, type AuditOpts } from "./require-admin"

// Deletion workflow (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes.
//
// State machine: REQUESTED (recorded by the Phase 3 requestDeletion
// — the user, or an admin on their behalf) → APPROVED or REJECTED by
// an admin (reason required either way) → COMPLETED by the erasure.
// The request row is never deleted; it is the record that the erasure
// happened.
//
// Erasure is an ANONYMIZATION, not a row delete: the User row stays
// (its id is the foreign key of the billing/audit history) with its
// PII replaced. What the erasure DELETES vs KEEPS:
//
//   DELETED: OAuth accounts (credentials), sessions, API keys
//   (revoked), BYOK keys (credentials — must be gone), AI settings,
//   MCP settings, flag overrides, entitlement overrides, admin notes
//   ABOUT the user, domains + forms (cascade: fields, submissions +
//   events, notification settings, AI daily usage), EmailJob rows
//   addressed to the user or belonging to their forms, and
//   Verification rows for the old email (Phase 16, SRC-213).
//   KEPT: AuditLog and SubscriptionEvent rows (SetNull links — the
//   audit trail survives erasure). Subscription, UsageLedger,
//   AiUsageRecord and McpUsageRecord are Cascade off User and are
//   KEPT ONLY because erasure anonymizes the user row and never
//   calls db.user.delete (owner decision 2026-11-24, DB-005: keep
//   Cascade) — a hard user delete WOULD delete those rows with the
//   user. The audit row for the erasure itself carries only counts,
//   never PII.
//
// Guards (same as Phase 3): the PLATFORM_OWNER can never be erased;
// self-erasure is forbidden (403). A refused erasure attempt is
// recorded with outcome FAILED, never dropped.

export type DeletionRequestRow = {
  id: string
  userId: string
  user: { id: string; name: string | null; email: string } | null
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED"
  reason: string
  reviewedBy: { id: string; name: string | null; email: string } | null
  reviewedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const deletionRequestSelect = {
  id: true,
  userId: true,
  status: true,
  reason: true,
  reviewedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true, email: true } },
} as const

/** Every deletion request, newest first, with a status filter.
    MANAGE_USERS. */
export async function listDeletionRequests(
  actor: AdminSession,
  filters: {
    status?: "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED"
    page?: number
    perPage?: number
  } = {}
): Promise<{
  requests: DeletionRequestRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "MANAGE_USERS")
  const page = filters.page ?? 1
  const perPage = filters.perPage ?? 20
  const where: Prisma.DeletionRequestWhereInput = {}
  if (filters.status) where.status = filters.status
  const [total, rows] = await Promise.all([
    db.deletionRequest.count({ where }),
    db.deletionRequest.findMany({
      where,
      select: deletionRequestSelect,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return {
    requests: rows,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}

async function getDeletionRequestOrThrow(id: string) {
  const request = await db.deletionRequest.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          platformRole: true,
          status: true,
          deletionCompletedAt: true,
        },
      },
    },
  })
  if (!request) throw new ApiError("Deletion request not found.", 404)
  return request
}

// A refused erasure/review attempt is recorded with outcome FAILED
// before the error is thrown — a failed sensitive action is never
// dropped. The row carries the target id + reason, never PII.
async function auditRefusedErasure(
  actor: AdminSession,
  requestId: string,
  targetUserId: string,
  event: string,
  reason: string,
  opts: AuditOpts
): Promise<void> {
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.DELETION_REQUEST,
    resourceId: requestId,
    detail: { event, targetUserId, reason },
    reason,
    outcome: AuditOutcome.FAILED,
    correlationId: opts.correlationId,
  })
}

/** Reviews a REQUESTED request: APPROVED or REJECTED. MANAGE_USERS,
    reason required, audited. Any other state is a 409. */
export async function reviewDeletionRequest(
  actor: AdminSession,
  id: string,
  input: ReviewDeletionRequestInput,
  opts: AuditOpts = {}
): Promise<DeletionRequestRow> {
  requireAdmin(actor, "MANAGE_USERS")
  const request = await getDeletionRequestOrThrow(id)
  if (request.status !== "REQUESTED") {
    await auditRefusedErasure(
      actor,
      id,
      request.userId,
      "deletion-review-refused",
      input.reason,
      opts
    )
    throw new ApiError(
      `Only a REQUESTED deletion request can be reviewed (this one is ${request.status}).`,
      409
    )
  }
  // Step-up (Phase 9): APPROVING a deletion is high-impact — the
  // actor re-enters their password first. REJECTING needs none: it
  // preserves the account. Checked after the state guard, before the
  // write.
  if (input.decision === "APPROVED") {
    await requireStepUp(actor)
  }
  const now = new Date()
  const updated = await db.deletionRequest.update({
    where: { id },
    data: {
      status: input.decision,
      reviewedById: actor.user.id,
      reviewedAt: now,
    },
    select: deletionRequestSelect,
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.DELETION_REQUEST,
    resourceId: id,
    detail: {
      event: "deletion-request-reviewed",
      decision: input.decision,
      targetUserId: request.userId,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  return updated
}

/** Executes the erasure for an APPROVED request. MANAGE_USERS, reason
    required. The anonymization + all deletes run in ONE transaction;
    the request flips to COMPLETED inside the same transaction. A
    concurrent double-erasure is harmless (the anonymized values are
    deterministic from the user id, and every delete is idempotent),
    so no row locking is needed. Audited with the deleted-row counts,
    never any PII. */
export async function executeErasure(
  actor: AdminSession,
  id: string,
  input: ExecuteErasureInput,
  opts: AuditOpts = {}
): Promise<DeletionRequestRow> {
  requireAdmin(actor, "MANAGE_USERS")
  const request = await getDeletionRequestOrThrow(id)
  const target = request.user
  if (!target) throw new ApiError("Deletion request not found.", 404)
  if (target.platformRole === "PLATFORM_OWNER") {
    await auditRefusedErasure(
      actor,
      id,
      target.id,
      "erasure-refused-owner",
      input.reason,
      opts
    )
    throw new ApiError("The platform owner can never be erased.", 403)
  }
  if (actor.user.id === target.id) {
    await auditRefusedErasure(
      actor,
      id,
      target.id,
      "erasure-refused-self",
      input.reason,
      opts
    )
    throw new ApiError("You cannot erase your own account.", 403)
  }
  if (request.status !== "APPROVED") {
    await auditRefusedErasure(
      actor,
      id,
      target.id,
      "erasure-refused-state",
      input.reason,
      opts
    )
    throw new ApiError(
      `Only an APPROVED deletion request can be erased (this one is ${request.status}).`,
      409
    )
  }
  if (target.deletionCompletedAt) {
    await auditRefusedErasure(
      actor,
      id,
      target.id,
      "erasure-refused-already-erased",
      input.reason,
      opts
    )
    throw new ApiError("This account has already been erased.", 409)
  }
  // Step-up (Phase 9): the erasure itself is irreversible — the actor
  // re-enters their password first. Checked last, after every cheap
  // guard, immediately before the transaction.
  await requireStepUp(actor)

  // SRC-213: capture the old email BEFORE the anonymizing update —
  // the EmailJob/Verification cleanup below keys off it, and the
  // update must not be able to move the value under us.
  const oldEmail = target.email
  const now = new Date()
  const counts = await db.$transaction(async (tx) => {
    // Re-check inside the transaction: the state is the enforcement
    // point, so a request reviewed between the guard read and this
    // transaction cannot be erased.
    const fresh = await tx.deletionRequest.findUnique({
      where: { id },
      select: { status: true },
    })
    if (!fresh || fresh.status !== "APPROVED") {
      throw new ApiError(
        `Only an APPROVED deletion request can be erased (this one is ${fresh?.status ?? "missing"}).`,
        409
      )
    }
    const anonymizedEmail = `deleted-${target.id.slice(-8)}@deleted.local`
    await tx.user.update({
      where: { id: target.id },
      data: {
        email: anonymizedEmail,
        name: "Deleted user",
        image: null,
        status: "DISABLED",
        statusReason: "Account erased",
        deletionCompletedAt: now,
        locale: null,
      },
    })
    // SRC-213: EmailJob rows are NOT removed by the form cascade
    // (their form/submission FKs are SetNull), so delete them here
    // before the forms go away — the form filter needs the ids while
    // the forms still exist. Verification rows are keyed by the old
    // email and would otherwise keep a live token for it.
    const userFormIds = (
      await tx.form.findMany({
        where: { ownerId: target.id },
        select: { id: true },
      })
    ).map((f) => f.id)
    const [
      accounts,
      keys,
      sessions,
      byokKeys,
      aiSettings,
      mcpSettings,
      flagOverrides,
      entitlementOverrides,
      notes,
      domains,
      forms,
      emailJobs,
      verifications,
    ] = await Promise.all([
      tx.account.deleteMany({ where: { userId: target.id } }),
      tx.apiKey.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now },
      }),
      tx.session.deleteMany({ where: { userId: target.id } }),
      tx.userAiKey.deleteMany({ where: { userId: target.id } }),
      tx.userAiSettings.deleteMany({ where: { userId: target.id } }),
      tx.mcpUserSettings.deleteMany({ where: { userId: target.id } }),
      tx.featureFlagOverride.deleteMany({ where: { userId: target.id } }),
      tx.entitlementOverride.deleteMany({ where: { userId: target.id } }),
      tx.adminNote.deleteMany({ where: { userId: target.id } }),
      tx.domain.deleteMany({ where: { ownerId: target.id } }),
      tx.form.deleteMany({ where: { ownerId: target.id } }),
      tx.emailJob.deleteMany({
        where: {
          OR: [{ to: oldEmail }, { formId: { in: userFormIds } }],
        },
      }),
      tx.verification.deleteMany({
        where: { identifier: oldEmail },
      }),
    ])
    await tx.deletionRequest.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: now },
    })
    return {
      accountsDeleted: accounts.count,
      apiKeysRevoked: keys.count,
      sessionsDeleted: sessions.count,
      byokKeysDeleted: byokKeys.count,
      aiSettingsDeleted: aiSettings.count,
      mcpSettingsDeleted: mcpSettings.count,
      flagOverridesDeleted: flagOverrides.count,
      entitlementOverridesDeleted: entitlementOverrides.count,
      adminNotesDeleted: notes.count,
      domainsDeleted: domains.count,
      formsDeleted: forms.count,
      emailJobsDeleted: emailJobs.count,
      verificationsDeleted: verifications.count,
    }
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.DELETION_REQUEST,
    resourceId: id,
    detail: {
      event: "account-erased",
      targetUserId: target.id,
      counts,
    },
    reason: input.reason,
    correlationId: opts.correlationId,
  })
  const completed = await db.deletionRequest.findUnique({
    where: { id },
    select: deletionRequestSelect,
  })
  if (!completed) throw new ApiError("Deletion request not found.", 404)
  return completed
}
