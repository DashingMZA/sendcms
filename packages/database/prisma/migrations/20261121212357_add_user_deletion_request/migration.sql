-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestReason" TEXT,
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3);
