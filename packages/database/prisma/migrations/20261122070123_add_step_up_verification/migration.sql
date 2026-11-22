-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'STEP_UP_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'STEP_UP_FAILED';
ALTER TYPE "RateLimitScope" ADD VALUE 'STEP_UP';

-- CreateTable
CREATE TABLE "StepUpVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepUpVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepUpVerification_userId_expiresAt_idx" ON "StepUpVerification"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "StepUpVerification" ADD CONSTRAINT "StepUpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
