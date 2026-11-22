import { AuditAction, AuditOutcome, AuditResource, db } from "@sendcms/database"
import type { Prisma } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"

const logger = createLogger("audit")

export type AuditLogInput = {
  /** Who did it; omit for system actions (the row's userId stays null). */
  userId?: string | null
  action: AuditAction
  resourceType: AuditResource
  resourceId: string
  /** What changed (before/after, reason). */
  detail?: Prisma.InputJsonValue
  ipAddress?: string | null
  // Admin Control Plane (Phase 7) — the justification for the action
  // (required for critical actions), the request correlation id, and
  // whether the action succeeded. All optional: a caller that passes
  // nothing gets the pre-Phase 7 behaviour (SUCCESS from the schema
  // @default, no reason, no correlation id).
  reason?: string | null
  correlationId?: string | null
  outcome?: AuditOutcome
}

/**
 * Shared audit writer (Phase 10) — replaces the three per-service
 * wrappers that domains, forms, and auth each carried (same try/catch,
 * same shape, three copies).
 *
 * Best-effort by design: an audit write must never fail the request
 * that triggered it, so a failure is logged (structured, via the
 * observability logger) and the call resolves.
 *
 * Idempotency (Phase 7): the same correlationId + action + resource
 * must never produce two rows (a retried request, or a route that
 * audits twice). The check is best-effort and race-tolerant — it is
 * not a uniqueness guarantee, but it collapses the ordinary retry
 * case to one row.
 *
 * Layered-flow note: this is the audit writer's documented exception
 * to "only services import `@sendcms/database`" (like `packages/auth`
 * is for auth) — it exists so the audit write lives in one place, and
 * it is called only from services.
 */
export async function logAudit(input: AuditLogInput): Promise<void> {
  try {
    if (input.correlationId) {
      const existing = await db.auditLog.findFirst({
        where: {
          correlationId: input.correlationId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
        select: { id: true },
      })
      if (existing) return
    }
    await db.auditLog.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        detail: input.detail ?? undefined,
        ipAddress: input.ipAddress ?? undefined,
        userId: input.userId ?? undefined,
        reason: input.reason ?? undefined,
        correlationId: input.correlationId ?? undefined,
        // Pass undefined (not "SUCCESS") when the caller says nothing:
        // the schema @default(SUCCESS) fills it in, so the write shape
        // is byte-identical to pre-Phase 7 and existing exact-call
        // assertions (tests/security.test.ts) keep passing.
        outcome: input.outcome ?? undefined,
      },
    })
  } catch (err) {
    logger.error("audit log failed", {
      error: err,
      action: input.action,
      resourceType: input.resourceType,
    })
  }
}
