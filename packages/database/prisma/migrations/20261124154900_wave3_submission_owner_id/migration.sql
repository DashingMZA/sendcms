-- Phase 16, Wave 3 (Stream A) — Submission.ownerId denormalization.
--
-- Closes the SCHEMA half of PRF-011 (the query rewrites are Stream B's,
-- after this column lands) plus DB-011 (IP + rescore indexes) and the
-- Submission leg of PRF-012 ([createdAt]).
--
-- Why a denormalized ownerId: every owner-scoped query (inbox list /
-- counts, monthly quota check, analytics) filters submissions by owner
-- across forms, and all formId-leading indexes are useless for that —
-- without this column those queries join Form and then collect + sort
-- the owner's full submission set. The value is set from form.ownerId
-- on create (packages/modules/submissions/src/service.ts, inside the
-- same advisory lock that serializes the owner's submits) and can
-- never disagree with the form's owner. Cascade matches Form.owner
-- (erasure anonymizes the user row and never hard-deletes it — DB-005).
--
-- Backfill / verification (this migration):
--   1. ADD COLUMN nullable (NOT NULL directly would fail on any
--      populated table — the naive Prisma diff output).
--   2. UPDATE from Form.ownerId via the formId FK. Every submission
--      has a form (FK-enforced), so every row gets a value.
--   3. ALTER COLUMN SET NOT NULL — this IS the verification: it fails
--      loudly if any row is left unbackfilled.
--   4. ADD CONSTRAINT FK to User (CASCADE, matching Form.owner) and
--      the five indexes below.
-- The new column is NOT NULL in the schema, so any future direct
-- db.submission.create without ownerId fails fast instead of silently
-- writing an owner-less row. NOTE: packages/database/prisma/seed.ts
-- creates sample submissions without ownerId — it must set
-- ownerId: <demo user id> before the next `pnpm db:seed` (Stream B
-- owns the seed; flagged in the Wave 3 execution record).

-- AlterTable (PRF-011): add the column nullable first.
ALTER TABLE "Submission" ADD COLUMN "ownerId" TEXT;

-- Backfill (PRF-011): every submission takes its form's owner.
UPDATE "Submission" SET "ownerId" = "Form"."ownerId" FROM "Form" WHERE "Submission"."formId" = "Form"."id";

-- Verification (PRF-011): fails if any row is still NULL.
ALTER TABLE "Submission" ALTER COLUMN "ownerId" SET NOT NULL;

-- AddForeignKey (PRF-011)
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (PRF-011): owner-scoped inbox list / counts / quota check.
CREATE INDEX "Submission_ownerId_createdAt_idx" ON "Submission"("ownerId", "createdAt");
CREATE INDEX "Submission_ownerId_status_createdAt_idx" ON "Submission"("ownerId", "status", "createdAt");

-- CreateIndex (DB-011): public-submit IP rate-limit counts filter on
-- ipAddress + createdAt with no formId.
CREATE INDEX "Submission_ipAddress_createdAt_idx" ON "Submission"("ipAddress", "createdAt");

-- CreateIndex (DB-011): AI rescore candidates filter status = NEW AND
-- aiScoredAt IS NULL, ordered by createdAt. A partial index
-- (WHERE status = 'NEW' AND "aiScoredAt" IS NULL) would be smaller,
-- but Prisma cannot express partial indexes — it would be a
-- hand-written raw object, invisible to the schema (the DB-020 drift
-- problem). The plain composite stays Prisma-managed and also serves
-- any other status + aiScoredAt filter.
CREATE INDEX "Submission_status_aiScoredAt_createdAt_idx" ON "Submission"("status", "aiScoredAt", "createdAt");

-- CreateIndex (PRF-012): bare date-range aggregates (admin overview /
-- health "submissions today") filter on createdAt alone.
CREATE INDEX "Submission_createdAt_idx" ON "Submission"("createdAt");
