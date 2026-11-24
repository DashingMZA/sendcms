-- BIL-129 (Phase 16, Wave 3): seed the five BillingProviderConfig rows.
-- Before this migration the admin GET /api/v1/admin/billing/providers
-- created these rows on first read (upsert-on-GET in listProviderConfigs),
-- so a read endpoint mutated the database and the rows' createdAt
-- reflected the first admin page view, not a deliberate setup action.
-- From here the rows exist from the migration, and the GET is a pure
-- read (a missing row is presented as disabled with no countries and
-- is never created by the read path). Idempotent: ON CONFLICT DO
-- NOTHING, so re-running the migration (or a DB that already has the
-- rows from the old upsert path) is a no-op. Deterministic ids keep
-- the follow-up country seed (20261124154600) joinable by provider.
-- All five start disabled: a provider can be enabled only when its
-- env credentials exist (enforced by setProviderConfig), and enabling
-- is an explicit admin action with a reason, never a seed default.
INSERT INTO "BillingProviderConfig" ("id", "provider", "isEnabled", "createdAt", "updatedAt")
VALUES
  ('billing-config-stripe', 'STRIPE', false, now(), now()),
  ('billing-config-paypal', 'PAYPAL', false, now(), now()),
  ('billing-config-polar', 'POLAR', false, now(), now()),
  ('billing-config-freemius', 'FREEMIUS', false, now(), now()),
  ('billing-config-gumroad', 'GUMROAD', false, now(), now())
ON CONFLICT ("provider") DO NOTHING;
