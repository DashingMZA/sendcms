-- Wave 8, Stream B — billing reconciliation backstops.
-- * User.stripeCustomerId (BIL-017): one Stripe Customer per user.
-- * PlanVersion provider catalog cache columns (SRC-222): the Stripe
--   Price / PayPal product + plan / Polar product created once per
--   plan version and reused by later checkouts.
-- * BillingEvent.kind (DB-015): the closed normalized-kind enum.
-- * CheckoutAttempt (BIL-028): one row per checkout creation.
-- * CHECK on PlanVersion.priceCurrency (DB-015): ISO alpha-3 only.
--   Prisma cannot express a CHECK in schema, so it lives here (same
--   precedent as the single-platform-owner partial index, DB-020);
--   `prisma migrate diff --from-migrations --to-schema` is expected
--   to report exactly this CHECK as drift, and nothing else.
-- CreateEnum
CREATE TYPE "BillingEventKind" AS ENUM ('CHECKOUT_COMPLETED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_UPDATED', 'PAYMENT_REFUNDED', 'UNMAPPED_PAYMENT', 'IGNORED');

-- CreateEnum
CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('CREATED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "PlanVersion" ADD COLUMN     "stripePriceId" TEXT,
ADD COLUMN     "paypalProductId" TEXT,
ADD COLUMN     "paypalPlanId" TEXT,
ADD COLUMN     "polarProductId" TEXT;

-- AlterTable
ALTER TABLE "BillingEvent" ADD COLUMN     "kind" "BillingEventKind";

-- CreateTable
CREATE TABLE "CheckoutAttempt" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT,
    "planVersionId" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "providerCheckoutId" TEXT,
    "priceAmount" INTEGER,
    "priceCurrency" TEXT NOT NULL DEFAULT 'USD',
    "status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutAttempt_attemptId_key" ON "CheckoutAttempt"("attemptId");

-- CreateIndex
CREATE INDEX "CheckoutAttempt_userId_createdAt_idx" ON "CheckoutAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutAttempt_planVersionId_createdAt_idx" ON "CheckoutAttempt"("planVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutAttempt_provider_providerCheckoutId_idx" ON "CheckoutAttempt"("provider", "providerCheckoutId");

-- CreateIndex
CREATE INDEX "BillingEvent_kind_createdAt_idx" ON "BillingEvent"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB-015: currency codes are ISO 4217 alpha-3 (uppercase). Existing
-- rows satisfy this (dev/prod plans are USD); the CHECK rejects
-- "usd", "XX", or any non-3-letter value on insert/update.
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_priceCurrency_format" CHECK ("priceCurrency" ~ '^[A-Z]{3}$');
