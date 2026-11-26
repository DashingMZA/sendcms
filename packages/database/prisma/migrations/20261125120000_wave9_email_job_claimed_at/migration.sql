-- Phase 16, Wave 9 (Stream A) — EML-031 / EML-006 / SRC-302: claim lease.
--
-- EmailJob.claimedAt is set when a processor claims a job
-- (PENDING → SENDING) and cleared when the job is marked SENT/FAILED.
-- claimDueEmailJobs reclaims SENDING rows whose lease expired
-- (STALE_CLAIM_LEASE_MINUTES = 10 min), so a job stranded by a killed
-- worker is retried instead of sitting in SENDING forever. NULL on
-- pre-existing rows: those are treated as stale (their updatedAt
-- predates the lease anyway). No backfill — the reaper's NULL arm
-- covers them, and a live SENDING row's processor will mark it.
ALTER TABLE "EmailJob" ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "EmailJob_status_claimedAt_idx" ON "EmailJob"("status", "claimedAt");
