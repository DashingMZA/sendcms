-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENROUTER');

-- CreateEnum
CREATE TYPE "AiBillingMode" AS ENUM ('BYOK', 'PLATFORM', 'DISABLED');

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('SUCCESS', 'FAILED', 'RETRY');

-- CreateEnum
CREATE TYPE "AiKeyTestStatus" AS ENUM ('OK', 'FAILED', 'UNTESTED');

-- AlterEnum
ALTER TYPE "AuditResource" ADD VALUE 'AI_KEY';

-- CreateTable
CREATE TABLE "UserAiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "encryptedDek" TEXT NOT NULL,
    "keyIv" TEXT NOT NULL,
    "keyTag" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "model" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "masterKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" "AiKeyTestStatus" NOT NULL DEFAULT 'UNTESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProviderConfig" (
    "id" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedModels" JSONB NOT NULL,
    "defaultModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "billingMode" "AiBillingMode" NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costMicros" INTEGER,
    "status" "AiUsageStatus" NOT NULL,
    "sourceEvent" TEXT,
    "resourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAiKey_userId_idx" ON "UserAiKey"("userId");

-- CreateIndex
CREATE INDEX "UserAiKey_provider_idx" ON "UserAiKey"("provider");

-- CreateIndex
CREATE INDEX "UserAiKey_userId_isEnabled_idx" ON "UserAiKey"("userId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "UserAiKey_userId_provider_key" ON "UserAiKey"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConfig_provider_key" ON "AiProviderConfig"("provider");

-- CreateIndex
CREATE INDEX "AiProviderConfig_provider_idx" ON "AiProviderConfig"("provider");

-- CreateIndex
CREATE INDEX "AiUsageRecord_userId_createdAt_idx" ON "AiUsageRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageRecord_provider_createdAt_idx" ON "AiUsageRecord"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageRecord_billingMode_createdAt_idx" ON "AiUsageRecord"("billingMode", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageRecord_userId_billingMode_createdAt_idx" ON "AiUsageRecord"("userId", "billingMode", "createdAt");

-- AddForeignKey
ALTER TABLE "UserAiKey" ADD CONSTRAINT "UserAiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageRecord" ADD CONSTRAINT "AiUsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
