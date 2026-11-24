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
 * Idempotency (Phase 7, backstopped by the DB in Phase 16, DB-004):
 * the same correlationId + action + resource must never produce two
 * rows (a retried request, or a route that audits twice). The write
 * inserts directly and treats the partial unique index's P2002 as
 * "already logged" — the check-then-create pre-check this replaced
 * was race-prone (SRC-331: two concurrent retries both passed it).
 *
 * Layered-flow note: this is the audit writer's documented exception
 * to "only services import `@sendcms/database`" (like `packages/auth`
 * is for auth) — it exists so the audit write lives in one place, and
 * it is called only from services.
 */
export async function logAudit(input: AuditLogInput): Promise<void> {
  try {
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
    // A unique-violation on the correlation tuple means a concurrent
    // retry already logged this row — that IS the idempotent outcome,
    // not a failure.
    if (isUniqueViolation(err)) return
    logger.error("audit log failed", {
      error: err,
      action: input.action,
      resourceType: input.resourceType,
    })
  }
}

/** Prisma unique-constraint violation (P2002). Code-checked (not
    instanceof) so hand-built fakes in tests can exercise the path. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  )
}
