import { AuditAction, AuditResource, db } from "@sendcms/database"
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
