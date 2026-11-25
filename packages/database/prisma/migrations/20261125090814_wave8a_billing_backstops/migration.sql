-- CreateEnum
CREATE TYPE "OneTimePurchaseStatus" AS ENUM ('ACTIVE', 'REFUNDED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SubscriptionEventType" ADD VALUE 'CANCEL_SCHEDULED';
ALTER TYPE "SubscriptionEventType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "SubscriptionEventType" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "SubscriptionEvent" ADD COLUMN     "providerEventId" TEXT;

-- AlterTable
ALTER TABLE "McpUsageRecord" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "OneTimePurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "provider" "BillingProvider" NOT NULL,
    "providerReference" TEXT NOT NULL,
    "checkoutId" TEXT,
    "priceAmount" INTEGER,
    "priceCurrency" TEXT NOT NULL DEFAULT 'USD',
    "accessStart" TIMESTAMP(3) NOT NULL,
    "accessEnd" TIMESTAMP(3) NOT NULL,
    "status" "OneTimePurchaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneTimePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OneTimePurchase_userId_status_idx" ON "OneTimePurchase"("userId", "status");

-- CreateIndex
CREATE INDEX "OneTimePurchase_planId_idx" ON "OneTimePurchase"("planId");

-- CreateIndex
CREATE INDEX "OneTimePurchase_planVersionId_idx" ON "OneTimePurchase"("planVersionId");

-- CreateIndex
CREATE INDEX "OneTimePurchase_subscriptionId_idx" ON "OneTimePurchase"("subscriptionId");

-- CreateIndex
CREATE INDEX "OneTimePurchase_status_accessEnd_idx" ON "OneTimePurchase"("status", "accessEnd");

-- CreateIndex
CREATE UNIQUE INDEX "OneTimePurchase_provider_providerReference_key" ON "OneTimePurchase"("provider", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key" ON "Subscription"("provider", "providerSubscriptionId");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_providerEventId_idx" ON "SubscriptionEvent"("providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "McpUsageRecord_idempotencyKey_key" ON "McpUsageRecord"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "OneTimePurchase" ADD CONSTRAINT "OneTimePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimePurchase" ADD CONSTRAINT "OneTimePurchase_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimePurchase" ADD CONSTRAINT "OneTimePurchase_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OneTimePurchase" ADD CONSTRAINT "OneTimePurchase_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Phase 16, Wave 8 (Stream A) — hand-written backstops ──────────
-- Closes: DB-001 (PlanVersion immutability trigger), DB-021
-- (one-ACTIVE-subscription partial unique index), DB-002/DB-024
-- (unique (provider, providerSubscriptionId) above), DB-003
-- (McpUsageRecord.idempotencyKey above), BIL-003 (OneTimePurchase
-- table above).
--
-- PRE-APPLY DATA CHECKS (run before applying to a DB with live data;
-- the coordinator applies the full Wave 8 set at consolidation):
--   1. No user may hold two ACTIVE/TRIALING/PAST_DUE subscriptions:
--      SELECT "userId", count(*) FROM "Subscription"
--      WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE')
--      GROUP BY "userId" HAVING count(*) > 1;
--      (Any row found must be resolved — cancel the duplicate —
--      before the partial index below is created, or it fails.)
--   2. No duplicate (provider, providerSubscriptionId) pairs:
--      SELECT "provider", "providerSubscriptionId", count(*) FROM
--      "Subscription" WHERE "providerSubscriptionId" IS NOT NULL
--      GROUP BY 1, 2 HAVING count(*) > 1;
--   3. No duplicate McpUsageRecord.idempotencyKey values (NULLs do
--      not collide in Postgres, so pre-existing rows are safe).

-- DB-001 (owner decision 2026-11-24): a PUBLISHED or SUPERSEDED
-- plan version's terms are immutable in place. Status-only
-- transitions (publish / supersede / archive) still pass; only
-- changes to the five terms columns are rejected. DRAFT and ARCHIVED
-- rows are untouched by this trigger (ARCHIVED was deliberately
-- left out of the owner decision — an archived version's terms are
-- already out of circulation, and blocking its edits would freeze
-- legitimate clean-up).
CREATE OR REPLACE FUNCTION prevent_published_plan_version_terms_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED', 'SUPERSEDED') AND (
    NEW."priceAmount" IS DISTINCT FROM OLD."priceAmount" OR
    NEW."priceCurrency" IS DISTINCT FROM OLD."priceCurrency" OR
    NEW."billingInterval" IS DISTINCT FROM OLD."billingInterval" OR
    NEW."trialDays" IS DISTINCT FROM OLD."trialDays" OR
    NEW."entitlements" IS DISTINCT FROM OLD."entitlements"
  ) THEN
    RAISE EXCEPTION 'A PUBLISHED or SUPERSEDED plan version cannot be edited in place (planVersion %). Create a new version instead.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plan_version_terms_immutable ON "PlanVersion";
CREATE TRIGGER plan_version_terms_immutable
  BEFORE UPDATE ON "PlanVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_published_plan_version_terms_change();

-- DB-021 / DB-009: one ACTIVE/TRIALING/PAST_DUE subscription per
-- user, enforced in the DB (Prisma cannot express a partial unique
-- index in schema — same precedent as the single-platform-owner
-- index, DB-020). PAST_DUE is included because it is the same live
-- subscription in its grace window (findActiveSubscription treats
-- it as active); the service cancels PAST_DUE rows alongside
-- ACTIVE/TRIALING ones when superseding, so the index never blocks
-- a legitimate assign/activate.
CREATE UNIQUE INDEX "Subscription_single_active_idx"
  ON "Subscription" ("userId")
  WHERE "status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE');
