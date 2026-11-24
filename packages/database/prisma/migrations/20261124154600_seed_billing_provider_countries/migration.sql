-- BIL-125 (Phase 16, Wave 3): seed the owner-approved per-provider
-- country defaults (docs/admin-control-plane/billing-providers.md,
-- "Owner defaults (2026-11-22)": Stripe all countries; PayPal USA, UK,
-- Australia, Germany and similar; Gumroad Pakistan). Before this
-- migration every provider had zero mapping rows, which the code treats
-- as "everywhere" — so an enabled PayPal was offered in countries
-- where PayPal does not operate, and Gumroad claimed all countries.
-- These are SEED defaults, not hardcoded service behaviour: the admin
-- can change any provider's countries later from the admin app
-- (setProviderConfig accepts any country codes from the Country table,
-- and the admin dialog lists the full Country table, not a fixed
-- subset). Stripe, Polar, and Freemius deliberately get NO rows here:
-- no rows = all countries, which is their approved default.
-- Idempotent: INSERT ... SELECT with ON CONFLICT DO NOTHING, so
-- re-running is a no-op and an admin's later edits are never clobbered
-- (a row the admin deleted stays deleted; a row the admin changed to a
-- different country is not re-added — the unique key is
-- (providerConfigId, countryCode), and only the exact seeded pairs
-- are inserted). Deterministic ids (no UUID-generating functions:
-- the repo's PK convention is cuid, and hand-written migrations must
-- not reach for UUID functions — see the migration-hygiene guide).
INSERT INTO "BillingProviderCountry" ("id", "providerConfigId", "countryCode")
SELECT 'billing-country-paypal-' || lower(c."code"), cfg."id", c."code"
FROM "BillingProviderConfig" cfg
JOIN "Country" c ON c."code" IN ('US', 'GB', 'AU', 'DE')
WHERE cfg."provider" = 'PAYPAL'
ON CONFLICT ("providerConfigId", "countryCode") DO NOTHING;

INSERT INTO "BillingProviderCountry" ("id", "providerConfigId", "countryCode")
SELECT 'billing-country-gumroad-' || lower(c."code"), cfg."id", c."code"
FROM "BillingProviderConfig" cfg
JOIN "Country" c ON c."code" IN ('PK')
WHERE cfg."provider" = 'GUMROAD'
ON CONFLICT ("providerConfigId", "countryCode") DO NOTHING;
