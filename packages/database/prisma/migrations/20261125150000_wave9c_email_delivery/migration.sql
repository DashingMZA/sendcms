-- Phase 16, Wave 9 (Stream C) — email delivery tracking + suppression.
--
-- EML-005: the signed Resend webhook persists the provider-side
-- delivery outcome on the EmailJob (deliveryStatus /
-- deliveryUpdatedAt), looked up by providerMessageId.
-- EML-011: EmailSuppression records addresses that must receive no
-- further mail (hard bounce / complaint / unsubscribe).
-- SRC-217: EMAIL_QUEUED marks a reply as queued at enqueue time —
-- EMAIL_SENT is written later, from the outbox processor, once the
-- provider accepts it.

-- AlterEnum
ALTER TYPE "SubmissionEventType" ADD VALUE 'EMAIL_QUEUED';

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DELIVERED', 'BOUNCED', 'COMPLAINED', 'DELIVERY_DELAYED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED');

-- AlterTable
ALTER TABLE "EmailJob" ADD COLUMN "deliveryStatus" "EmailDeliveryStatus",
ADD COLUMN "deliveryUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "EmailJob_providerMessageId_idx" ON "EmailJob"("providerMessageId");

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "formId" TEXT,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_formId_key" ON "EmailSuppression"("email", "formId");
