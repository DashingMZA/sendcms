-- NOTE (Phase D, Worker A): `prisma migrate dev` generated two DROP INDEX
-- statements here for the PRF-019 trigram GIN indexes
-- ("Submission_originDomain_trgm_idx", "Submission_pageUrl_trgm_idx").
-- Those indexes live OUTSIDE the schema by design — Prisma cannot
-- express GIN indexes (see the PRF-019 comment on Submission in
-- schema.prisma) — so the diff flags them as drift on every new
-- migration. They serve inbox search and must NOT be dropped; the
-- DROP statements were removed from this migration by hand, same as
-- the Phase C pattern (migration 20261126143937_phasec_cron_run).
-- Only this migration file was edited, and only before it was applied
-- anywhere but scratch DBs.
--
-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'DISABLED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "AuditResource" ADD VALUE 'COUPON';

-- AlterTable
ALTER TABLE "CheckoutAttempt" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "discountAmountMinor" INTEGER;

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "discountType" "CouponDiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "maxRedemptionsPerUser" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "appliesToPlanIds" TEXT[],
    "appliesToBillingInterval" "BillingInterval",
    "firstPurchaseOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "checkoutAttemptId" TEXT,
    "discountAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_code_idx" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_status_createdAt_idx" ON "Coupon"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Coupon_createdById_idx" ON "Coupon"("createdById");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_createdAt_idx" ON "CouponRedemption"("couponId", "createdAt");

-- CreateIndex
CREATE INDEX "CouponRedemption_userId_couponId_idx" ON "CouponRedemption"("userId", "couponId");

-- CreateIndex
CREATE INDEX "CouponRedemption_subscriptionId_idx" ON "CouponRedemption"("subscriptionId");

-- CreateIndex
CREATE INDEX "CouponRedemption_checkoutAttemptId_idx" ON "CouponRedemption"("checkoutAttemptId");

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_checkoutAttemptId_fkey" FOREIGN KEY ("checkoutAttemptId") REFERENCES "CheckoutAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
