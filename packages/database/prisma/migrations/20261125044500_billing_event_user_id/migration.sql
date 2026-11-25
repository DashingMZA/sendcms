-- Phase 16, Wave 6 (Stream A) — BillingEvent.userId link (BIL-092 completion).
--
-- The customer payment-history view needs to scope BillingEvent rows to
-- their owner, so the webhook handler attributes each event to the
-- customer it belongs to. Nullable: events that carry no identity
-- (ignored events, or events for a subscription SendCMS never
-- activated) stay owner-less. SetNull on user erasure: billing history
-- survives erasure, the link does not. No backfill: past events cannot
-- be attributed reliably after the fact (checkout events carry the
-- buyer, but renewals only carry the provider subscription id, and the
-- subscription row may since have been replaced) — attribution starts
-- with events received after this migration.
--
-- Verified: `prisma migrate diff --from-schema <HEAD schema>
-- --to-schema <HEAD schema + this change only> --script` renders
-- exactly these three statements.

-- AlterTable
ALTER TABLE "BillingEvent" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "BillingEvent_userId_createdAt_idx" ON "BillingEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
