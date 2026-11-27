-- NOTE (Phase C, Worker A): `prisma migrate dev` generated two DROP INDEX
-- statements here for the PRF-019 trigram GIN indexes
-- ("Submission_originDomain_trgm_idx", "Submission_pageUrl_trgm_idx").
-- Those indexes live OUTSIDE this schema by design — Prisma cannot
-- express GIN indexes (see the PRF-019 comment on Submission in
-- schema.prisma) — so the diff flags them as drift on every new
-- migration. They serve inbox search and must NOT be dropped; the
-- DROP statements were removed from this migration by hand, same as
-- the DB-020 partial-index pattern. Only this migration file was
-- edited, and only before it was applied anywhere but scratch DBs.

-- CreateEnum
CREATE TYPE "CronJobName" AS ENUM ('EMAIL_OUTBOX');

-- CreateEnum
CREATE TYPE "CronTrigger" AS ENUM ('VERCEL_CRON', 'WORKER', 'MANUAL');

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "jobName" "CronJobName" NOT NULL,
    "trigger" "CronTrigger" NOT NULL,
    "triggeredById" TEXT,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CronRun_jobName_createdAt_idx" ON "CronRun"("jobName", "createdAt");

-- CreateIndex
CREATE INDEX "CronRun_status_createdAt_idx" ON "CronRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CronRun" ADD CONSTRAINT "CronRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
