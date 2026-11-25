-- AlterEnum
ALTER TYPE "EmailJobType" ADD VALUE 'TEST_EMAIL';

-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "digestIntervalHours" INTEGER;

-- Backfill (Phase 16, EML-093): the new digest flag defaults OFF, so
-- without this every form that already received digests via
-- `aiEnabled` would silently stop. Forms that had AI on keep their
-- digest; new forms (and AI-off forms) start with it OFF.
UPDATE "Form" SET "digestEnabled" = true WHERE "aiEnabled" = true;
