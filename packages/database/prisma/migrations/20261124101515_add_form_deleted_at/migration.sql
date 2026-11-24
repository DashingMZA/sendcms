-- AlterTable
ALTER TABLE "Form" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Form_ownerId_deletedAt_idx" ON "Form"("ownerId", "deletedAt");
