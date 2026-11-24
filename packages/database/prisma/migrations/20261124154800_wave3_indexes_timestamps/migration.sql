-- Phase 16, Wave 3 (Stream A) — schema index + timestamp corrections.
--
-- Closes: DB-012 (12 missing FK indexes), DB-013 (Subscription webhook
-- composite), DB-014 (Plan / Domain / Announcement composites), DB-016
-- (Country + BillingProviderCountry timestamps), DB-034 (reporting
-- date-range indexes), DB-037 (BillingEvent.updatedAt), DB-038 + DB-040
-- (redundant indexes — ONE migration closes both IDs), PRF-012
-- (createdAt-leading indexes on AiUsageRecord / McpUsageRecord — the
-- Submission leg lives in 20261124154900_wave3_submission_owner_id).
--
-- DB-013 AuditLog leg SKIPPED, deliberately: the proposed composite
-- @@index([correlationId, action, resourceType, resourceId]) is
-- subsumed by Wave 1's DB-004 partial unique index
-- "AuditLog_correlation_idempotency_idx" on exactly those four columns
-- (migration 20261124103000). A second index would be pure write
-- overhead. No Session/Verification expiresAt index either: no expiry
-- sweep exists, so there is no query for it to serve.
--
-- Drops (DB-038/DB-040): 18 indexes that are strict prefixes of another
-- index/unique on the same model. Postgres serves every affected query
-- from the surviving composite's leading column(s):
--   DomainVerification[domainId] -> [domainId, status, createdAt]
--   FormDomain[formId] -> unique [formId, domainId] ([domainId] kept)
--   NotificationSettings[formId] -> unique [formId, email]
--   AiDailyUsage[formId] -> unique [formId, date]
--   AiProviderConfig[provider] -> provider @unique
--   UserAiSettings[userId] -> userId @unique
--   McpUserSettings[userId] -> userId @unique
--   EntitlementOverride[userId] -> unique [userId, meter]
--   FeatureFlagOverride[flagId] -> unique [flagId, userId]
--   Subscription[userId] -> [userId, status]
--   Subscription[providerSubscriptionId] -> new
--     [providerSubscriptionId, status, createdAt] (DB-013 composite)
--   Plan[status] -> [status, kind] (+ new [status, isPrivate])
--   Form[ownerId] -> [ownerId, active] / [ownerId, deletedAt]
--   ApiKey[userId] -> [userId, revokedAt, createdAt]
--   PlanVersion[planId] -> unique [planId, version] / [planId, status]
--   UserAiKey[userId] -> unique [userId, provider]
--   Domain[ownerId] -> new [ownerId, status] (added below)
--   EmailJob[formId] -> new [formId, createdAt] (added below)
-- Stream C EXPLAIN-verifies the affected queries after this lands.
--
-- Backfill / verification:
--   * Country.createdAt + BillingProviderCountry.createdAt: filled by
--     the DEFAULT CURRENT_TIMESTAMP on the ADD COLUMN (matches the
--     schema's @default(now())).
--   * BillingEvent.updatedAt + BillingProviderCountry.updatedAt: added
--     NULLABLE first, backfilled, then SET NOT NULL — deliberately NOT
--     a DB default, so the live column carries no default the schema
--     does not declare (an @updatedAt column must not gain a default).
--     BillingEvent backfills to COALESCE(processedAt, createdAt):
--     a processed row was last mutated when it was processed.
--     BillingProviderCountry backfills to createdAt (rows are
--     created by an admin action and never otherwise updated yet).
--   * The SET NOT NULL steps are the verification: they fail loudly
--     if any row is left unbackfilled.

-- DropIndex (DB-038 / DB-040)
DROP INDEX "Domain_ownerId_idx";
DROP INDEX "DomainVerification_domainId_idx";
DROP INDEX "Form_ownerId_idx";
DROP INDEX "FormDomain_formId_idx";
DROP INDEX "NotificationSettings_formId_idx";
DROP INDEX "EmailJob_formId_idx";
DROP INDEX "AiDailyUsage_formId_idx";
DROP INDEX "Plan_status_idx";
DROP INDEX "PlanVersion_planId_idx";
DROP INDEX "Subscription_userId_idx";
DROP INDEX "Subscription_providerSubscriptionId_idx";
DROP INDEX "EntitlementOverride_userId_idx";
DROP INDEX "UserAiKey_userId_idx";
DROP INDEX "ApiKey_userId_idx";
DROP INDEX "AiProviderConfig_provider_idx";
DROP INDEX "UserAiSettings_userId_idx";
DROP INDEX "McpUserSettings_userId_idx";
DROP INDEX "FeatureFlagOverride_flagId_idx";

-- AlterTable (DB-037): BillingEvent.updatedAt, backfilled, then NOT NULL.
ALTER TABLE "BillingEvent" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "BillingEvent" SET "updatedAt" = COALESCE("processedAt", "createdAt") WHERE "updatedAt" IS NULL;
ALTER TABLE "BillingEvent" ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable (DB-016): Country.createdAt (seed rows: never mutated,
-- so createdAt only — see the schema comment).
ALTER TABLE "Country" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable (DB-016): BillingProviderCountry timestamps.
ALTER TABLE "BillingProviderCountry" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "BillingProviderCountry" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "BillingProviderCountry" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "BillingProviderCountry" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateIndex (DB-012): AdminNote.adminId
CREATE INDEX "AdminNote_adminId_idx" ON "AdminNote"("adminId");

-- CreateIndex (DB-014): Domain [ownerId, status]
CREATE INDEX "Domain_ownerId_status_idx" ON "Domain"("ownerId", "status");

-- CreateIndex (DB-012): SubmissionEvent.actorId
CREATE INDEX "SubmissionEvent_actorId_idx" ON "SubmissionEvent"("actorId");

-- CreateIndex (DB-034): EmailJob [formId, createdAt]
CREATE INDEX "EmailJob_formId_createdAt_idx" ON "EmailJob"("formId", "createdAt");

-- CreateIndex (DB-034): AiDailyUsage [date]
CREATE INDEX "AiDailyUsage_date_idx" ON "AiDailyUsage"("date");

-- CreateIndex (DB-014): Plan [status, isPrivate]
CREATE INDEX "Plan_status_isPrivate_idx" ON "Plan"("status", "isPrivate");

-- CreateIndex (DB-012): Plan.currentVersionId
CREATE INDEX "Plan_currentVersionId_idx" ON "Plan"("currentVersionId");

-- CreateIndex (DB-012): PlanVersion.createdById
CREATE INDEX "PlanVersion_createdById_idx" ON "PlanVersion"("createdById");

-- CreateIndex (DB-013): Subscription webhook lookup
CREATE INDEX "Subscription_providerSubscriptionId_status_createdAt_idx" ON "Subscription"("providerSubscriptionId", "status", "createdAt");

-- CreateIndex (DB-012): SubscriptionEvent from/toPlanVersionId + adminId
CREATE INDEX "SubscriptionEvent_fromPlanVersionId_idx" ON "SubscriptionEvent"("fromPlanVersionId");
CREATE INDEX "SubscriptionEvent_toPlanVersionId_idx" ON "SubscriptionEvent"("toPlanVersionId");
CREATE INDEX "SubscriptionEvent_adminId_idx" ON "SubscriptionEvent"("adminId");

-- CreateIndex (DB-012): EntitlementOverride.adminId
CREATE INDEX "EntitlementOverride_adminId_idx" ON "EntitlementOverride"("adminId");

-- CreateIndex (DB-034 / PRF-012): AiUsageRecord [createdAt]
CREATE INDEX "AiUsageRecord_createdAt_idx" ON "AiUsageRecord"("createdAt");

-- CreateIndex (DB-034 / PRF-012): McpUsageRecord [createdAt]
CREATE INDEX "McpUsageRecord_createdAt_idx" ON "McpUsageRecord"("createdAt");

-- CreateIndex (DB-012): FeatureFlagOverride.adminId
CREATE INDEX "FeatureFlagOverride_adminId_idx" ON "FeatureFlagOverride"("adminId");

-- CreateIndex (DB-014): Announcement [isActive, audience, createdAt]
CREATE INDEX "Announcement_isActive_audience_createdAt_idx" ON "Announcement"("isActive", "audience", "createdAt");

-- CreateIndex (DB-012): Announcement.createdById
CREATE INDEX "Announcement_createdById_idx" ON "Announcement"("createdById");

-- CreateIndex (DB-012): DeletionRequest.reviewedById
CREATE INDEX "DeletionRequest_reviewedById_idx" ON "DeletionRequest"("reviewedById");

-- CreateIndex (DB-012): TicketMessage.authorId
CREATE INDEX "TicketMessage_authorId_idx" ON "TicketMessage"("authorId");
