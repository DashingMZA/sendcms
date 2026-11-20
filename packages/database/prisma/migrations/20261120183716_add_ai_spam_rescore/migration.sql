-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "aiScoredAt" TIMESTAMP(3),
ADD COLUMN     "aiSpamScore" INTEGER;

-- CreateTable
CREATE TABLE "AiDailyUsage" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiDailyUsage_formId_idx" ON "AiDailyUsage"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "AiDailyUsage_formId_date_key" ON "AiDailyUsage"("formId", "date");

-- AddForeignKey
ALTER TABLE "AiDailyUsage" ADD CONSTRAINT "AiDailyUsage_formId_fkey" FOREIGN KEY ("formId") REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
