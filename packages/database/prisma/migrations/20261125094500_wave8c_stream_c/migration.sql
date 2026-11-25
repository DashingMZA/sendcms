-- Phase 16, Wave 8 (Stream C) — AI / BYOK / MCP.
--
-- DB-018 / DB-041 / SRC-323: McpSettings is a singleton by DB
-- enforcement, not just by convention. The service upserts the one
-- row with id 'platform'; CHECK (id = 'platform') makes a second
-- row impossible (id is the PK, so at most one row can carry that
-- value — and no other value is allowed). The hot read path switches
-- to findUnique({ id: 'platform' }) at the same time.
--
-- DB-018: McpUsageRecord.tool is a closed set of 19 tool names
-- (packages/mcp/src/tools/names.ts, MCP_TOOL_NAMES). The CHECK pins
-- the list in the DB; the drift-guard test asserts the CHECK list
-- and the registry stay identical when a tool is added or renamed.
--
-- AIM-003: UserAiKey.authFailureCount — consecutive provider-auth
-- failures at call time; auto-disable at the threshold.
--
-- AIM-028: AiDailyOwnerUsage — the interactive AI daily-budget
-- counter, one row per owner per day (suggest-fields, draft-reply,
-- key-test have no form to count against).

-- AlterTable
ALTER TABLE "UserAiKey" ADD COLUMN "authFailureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AiDailyOwnerUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDailyOwnerUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiDailyOwnerUsage_userId_date_key" ON "AiDailyOwnerUsage"("userId", "date");

-- AddForeignKey
ALTER TABLE "AiDailyOwnerUsage" ADD CONSTRAINT "AiDailyOwnerUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- McpSettings singleton (DB-018 / DB-041 / SRC-323)
ALTER TABLE "McpSettings" ADD CONSTRAINT "McpSettings_single_row" CHECK ("id" = 'platform');

-- McpUsageRecord.tool closed set (DB-018)
ALTER TABLE "McpUsageRecord" ADD CONSTRAINT "McpUsageRecord_tool_check" CHECK ("tool" IN ('list_domains', 'get_domain', 'create_domain', 'verify_domain', 'delete_domain', 'list_forms', 'get_form', 'create_form', 'update_form', 'delete_form', 'list_submissions', 'get_submission', 'update_submission', 'bulk_update_submissions', 'delete_submission', 'get_overview', 'get_analytics', 'list_email_jobs', 'send_test_email'));
