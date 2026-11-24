-- AlterTable
ALTER TABLE "StepUpVerification" ADD COLUMN     "action" TEXT,
ADD COLUMN     "consumedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "StepUpVerification_userId_action_expiresAt_idx" ON "StepUpVerification"("userId", "action", "expiresAt");
