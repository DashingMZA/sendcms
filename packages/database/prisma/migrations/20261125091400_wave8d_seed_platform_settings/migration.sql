-- Phase 16, Wave 8 (Stream D) — seed the platform settings rows
-- that GET paths used to create on first read (SRC-235) and the two
-- AI-job feature flags that existed only as string constants
-- (DOC-023).
--
-- `McpSettings` ("platform"): the global MCP kill-switch row. The
-- getter (`getMcpSettings`) is now a pure read — missing row =
-- enabled (the schema default) — and `setMcpSettings` upserts on
-- write, so this seed only guarantees the row exists on a fresh
-- deploy; an admin's later toggle is never clobbered.
-- `AiProviderConfig`: one row per AI provider (OpenAI, Anthropic,
-- Google, DeepSeek, OpenRouter), all enabled with the platform
-- defaults (no model allowlist, no default model). The admin list
-- (`listProviderConfigs`) is now a pure read that returns the
-- in-memory defaults for any missing row, so this seed only
-- guarantees the rows exist; an admin's later edits are never
-- clobbered.
-- `FeatureFlag` (`ai-spam-rescore`, `ai-digest`): the two system
-- flags that gate the AI background jobs — `ai-spam-rescore` gates
-- `rescoreNewSubmissions`, `ai-digest` gates `sendDueDigests`
-- (`packages/modules/submissions/src/service.ts`; both jobs run from
-- the `GET /api/cron/email-outbox` hit and the standalone email
-- worker). Seeded DISABLED: a fresh deploy must not start calling
-- AI until an admin enables the flag in /admin/features (and a
-- platform key is configured). Before this migration the flags
-- existed only as string constants, so a fresh deploy silently ran
-- both jobs as zero-count no-ops with nothing telling the operator
-- why. See docs/deployment.md ("AI background jobs") and
-- docs/operations/runbook.md.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING, so re-running is a
-- no-op and an admin's later edits are never clobbered (a row the
-- admin deleted stays deleted; a row the admin changed is not
-- reset). Deterministic ids (no UUID-generating functions: the
-- repo's PK convention is cuid, and hand-written migrations must
-- not reach for UUID functions — see the migration-hygiene note in
-- 20261124154600_seed_billing_provider_countries/migration.sql).
-- Verified: applies cleanly on a scratch Postgres (see
-- ~/workspace/.audit-phase16/wave8/stream-d/report.md).

-- The global MCP kill-switch row (SRC-235).
INSERT INTO "McpSettings" ("id", "globalEnabled", "createdAt", "updatedAt")
VALUES ('platform', true, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- One AI provider config row per provider (SRC-235).
INSERT INTO "AiProviderConfig" ("id", "provider", "isEnabled", "allowedModels", "defaultModel", "createdAt", "updatedAt")
VALUES
  ('seed-ai-provider-openai', 'OPENAI', true, '[]'::jsonb, NULL, NOW(), NOW()),
  ('seed-ai-provider-anthropic', 'ANTHROPIC', true, '[]'::jsonb, NULL, NOW(), NOW()),
  ('seed-ai-provider-google', 'GOOGLE', true, '[]'::jsonb, NULL, NOW(), NOW()),
  ('seed-ai-provider-deepseek', 'DEEPSEEK', true, '[]'::jsonb, NULL, NOW(), NOW()),
  ('seed-ai-provider-openrouter', 'OPENROUTER', true, '[]'::jsonb, NULL, NOW(), NOW())
ON CONFLICT ("provider") DO NOTHING;

-- The two AI-job system flags, disabled by default (DOC-023).
INSERT INTO "FeatureFlag" ("id", "key", "name", "description", "isEnabled", "createdAt", "updatedAt")
VALUES
  ('seed-flag-ai-spam-rescore', 'ai-spam-rescore', 'AI spam re-scoring', 'Re-scores unscored NEW submissions with the AI spam filter (rescoreNewSubmissions, run by the email-outbox cron and the email worker). Enable in /admin/features once a platform AI key is configured.', false, NOW(), NOW()),
  ('seed-flag-ai-digest', 'ai-digest', 'AI inbox digest', 'Sends due per-form inbox digests (sendDueDigests, run by the email-outbox cron and the email worker). Enable in /admin/features once digest emails are wanted.', false, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;
