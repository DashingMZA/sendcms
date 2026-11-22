-- CreateEnum
CREATE TYPE "RateLimitScope" AS ENUM ('ADMIN_API', 'AUTH');

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "scope" "RateLimitScope" NOT NULL,
    "subject" TEXT NOT NULL,
    "minuteWindowStart" TIMESTAMP(3) NOT NULL,
    "minuteCount" INTEGER NOT NULL DEFAULT 0,
    "hourWindowStart" TIMESTAMP(3) NOT NULL,
    "hourCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_scope_subject_key" ON "RateLimitBucket"("scope", "subject");
