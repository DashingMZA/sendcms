-- Phase 16, Wave 3 (Stream D) — EmailJob.ownerId denormalization.
--
-- Closes the DB-034 EmailJob leg: listEmailJobsForUser filters jobs by
-- owner across forms, and the Wave 3 @@index([formId, createdAt]) serves
-- only the per-form read — Stream C proved the owner-wide listing still
-- seq-scans at 220k rows (55.7 ms, scaling linearly with the whole
-- table). Same pattern as the Submission ownerId migration
-- (20261124154900_wave3_submission_owner_id, PRF-011).
--
-- Why a denormalized ownerId: every owner-scoped outbox query (the
-- list, its total, its per-status counts) filters jobs by owner across
-- forms, and all formId-leading indexes are useless for that — without
-- this column those queries join Form and then collect + sort the
-- owner's full job set. The value is set from form.ownerId at enqueue
-- time (packages/modules/notifications/src/service.ts, resolved from
-- the form before the create) and can never disagree with the form's
-- owner — Form.ownerId has no update path. Cascade matches Form.owner
-- (erasure anonymizes the user row and never hard-deletes it — DB-005).
--
-- Backfill / verification (this migration):
--   1. ADD COLUMN nullable (NOT NULL directly would fail on any
--      populated table — the naive Prisma diff output).
--   2. UPDATE from Form.ownerId via the formId FK. Every live job has
--      a form (FK-enforced; verified: 0 NULL formIds, 0 dangling
--      formIds on the dev DB before this migration).
--   3. ALTER COLUMN SET NOT NULL — this IS the verification: it fails
--      loudly if any row is left unbackfilled.
--   4. ADD CONSTRAINT FK to User (CASCADE, matching Form.owner) and
--      the two indexes below.
-- The new column is NOT NULL in the schema, so any future direct
-- db.emailJob.create without ownerId fails fast instead of silently
-- writing an owner-less row. NOTE: no seed creates EmailJob rows, so
-- the seed needs no change.

-- AlterTable (DB-034): add the column nullable first.
ALTER TABLE "EmailJob" ADD COLUMN "ownerId" TEXT;

-- Backfill (DB-034): every job takes its form's owner.
UPDATE "EmailJob" SET "ownerId" = "Form"."ownerId" FROM "Form" WHERE "EmailJob"."formId" = "Form"."id";

-- Verification (DB-034): fails if any row is still NULL.
ALTER TABLE "EmailJob" ALTER COLUMN "ownerId" SET NOT NULL;

-- AddForeignKey (DB-034)
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (DB-034): owner-scoped outbox list / counts.
CREATE INDEX "EmailJob_ownerId_createdAt_idx" ON "EmailJob"("ownerId", "createdAt");
CREATE INDEX "EmailJob_ownerId_status_createdAt_idx" ON "EmailJob"("ownerId", "status", "createdAt");
