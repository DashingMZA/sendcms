import { z } from "zod"

// Seven admin pages, Phase C — Jobs (plan §3.6, Q8): the query schema
// for the CronRun list (GET /api/v1/admin/jobs/cron-runs, route stream).
// Local string enums, NOT `z.nativeEnum` on the Prisma enums: importing
// the Prisma client runtime into validators would pull it into the
// client bundle (SRC-230). The drift-guard test in
// tests/seven-pages-phase-c-worker-a.test.ts asserts this list and the
// Prisma enums stay identical.
export const CronJobNameSchema = z.enum(["EMAIL_OUTBOX"])

export const CronTriggerSchema = z.enum(["VERCEL_CRON", "WORKER", "MANUAL"])

export const CronRunStatusSchema = z.enum([
  "RUNNING",
  "SUCCESS",
  "PARTIAL",
  "FAILED",
])

export const CronRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  jobName: CronJobNameSchema.optional(),
  status: CronRunStatusSchema.optional(),
  trigger: CronTriggerSchema.optional(),
})

export type CronRunsQuery = z.infer<typeof CronRunsQuerySchema>
