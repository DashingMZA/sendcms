-- DOC-003 (registration toggle + manual-approval queue):
-- one new UserStatus value (PENDING_APPROVAL), one new EmailJobType
-- value (ACCOUNT_APPROVED), and the seeded `registration` flag (D2).
--
-- NOTE (Stream A): `prisma migrate dev` generated two DROP INDEX
-- statements here for the PRF-019 trigram GIN indexes
-- ("Submission_originDomain_trgm_idx", "Submission_pageUrl_trgm_idx").
-- Those indexes live OUTSIDE this schema by design — Prisma cannot
-- express GIN indexes (see the PRF-019 comment on Submission in
-- schema.prisma) — so the diff flags them as drift on every new
-- migration. They serve inbox search and must NOT be dropped; the
-- DROP statements were removed from this migration by hand, same as
-- the Phase C pattern (migration 20261126143937_phasec_cron_run) and
-- Phase D (migration 20261127072127_phased_coupons). Only this
-- migration file was edited, and only before it was applied anywhere
-- but scratch DBs.
--
-- The flag seed INSERT below is hand-added (Prisma cannot generate
-- data seeds from a schema diff), following the
-- 20261125091400_wave8d_seed_platform_settings pattern: deterministic
-- id, INSERT ... ON CONFLICT ("key") DO NOTHING, so re-running is a
-- no-op and an admin's later toggle is never clobbered. Seeded
-- ENABLED (D2): registration stays open until an admin closes it;
-- closing it by default would lock the owner out of their own sign-up.
--
-- Existing users: UNCHANGED. Every existing row keeps its current
-- status (ACTIVE/SUSPENDED/DISABLED); this migration adds enum values
-- and a flag row and touches no user row. No data backfill.

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterEnum
ALTER TYPE "EmailJobType" ADD VALUE 'ACCOUNT_APPROVED';

-- Seed the `registration` system flag (D2), enabled by default.
INSERT INTO "FeatureFlag" ("id", "key", "name", "description", "isEnabled", "createdAt", "updatedAt")
VALUES ('seed-flag-registration', 'registration', 'User registration', 'New user sign-ups. When off, sign-up is refused; when on, new users are created PENDING_APPROVAL until an admin approves them in /admin/all-users.', true, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;
