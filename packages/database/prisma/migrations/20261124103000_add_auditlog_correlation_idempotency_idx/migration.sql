-- Phase 16 (DB-004/SRC-331): one audit row per
-- (correlationId, action, resourceType, resourceId). Prisma cannot
-- express a partial unique index (correlationId is nullable), so this
-- raw migration adds it. Rows without a correlationId are unaffected
-- (the partial predicate excludes them).
CREATE UNIQUE INDEX "AuditLog_correlation_idempotency_idx" ON "AuditLog" ("correlationId", "action", "resourceType", "resourceId") WHERE "correlationId" IS NOT NULL;
