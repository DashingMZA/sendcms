-- Phase 16 (ADM-002/SRC-210): at most one open (REQUESTED/APPROVED)
-- deletion request per user. Prisma cannot express a partial unique
-- index, so this raw migration adds it (same pattern as
-- 20261124103000_add_auditlog_correlation_idempotency_idx). The
-- service still pre-checks (friendly 409) and translates a P2002 on
-- the create into the same 409, so two concurrent requests cannot
-- both succeed.
CREATE UNIQUE INDEX "DeletionRequest_one_open_idx" ON "DeletionRequest" ("userId") WHERE "status" IN ('REQUESTED', 'APPROVED');
