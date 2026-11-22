-- CreateEnum
CREATE TYPE "McpUsageStatus" AS ENUM ('SUCCESS', 'FAILED');

-- AlterEnum
ALTER TYPE "AuditResource" ADD VALUE 'MCP_SETTINGS';

-- CreateTable
CREATE TABLE "McpSettings" (
    "id" TEXT NOT NULL,
    "globalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpUserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedTools" JSONB,
    "minuteLimit" INTEGER,
    "hourLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpUserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpUsageRecord" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" "McpUsageStatus" NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpUserSettings_userId_key" ON "McpUserSettings"("userId");

-- CreateIndex
CREATE INDEX "McpUserSettings_userId_idx" ON "McpUserSettings"("userId");

-- CreateIndex
CREATE INDEX "McpUsageRecord_userId_createdAt_idx" ON "McpUsageRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpUsageRecord_apiKeyId_createdAt_idx" ON "McpUsageRecord"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "McpUsageRecord_tool_createdAt_idx" ON "McpUsageRecord"("tool", "createdAt");

-- CreateIndex
CREATE INDEX "McpUsageRecord_userId_tool_createdAt_idx" ON "McpUsageRecord"("userId", "tool", "createdAt");

-- AddForeignKey
ALTER TABLE "McpUserSettings" ADD CONSTRAINT "McpUserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUsageRecord" ADD CONSTRAINT "McpUsageRecord_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpUsageRecord" ADD CONSTRAINT "McpUsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
