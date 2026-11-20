-- AlterEnum
ALTER TYPE "EmailJobType" ADD VALUE 'DIGEST';

-- AlterTable
ALTER TABLE "EmailJob" ADD COLUMN     "payload" JSONB;

-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "lastDigestAt" TIMESTAMP(3);
