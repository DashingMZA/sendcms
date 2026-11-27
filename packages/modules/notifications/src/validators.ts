import { z } from "zod"

// Email notifications (Phase 8) — delivery log filters and test email.

export const EmailJobStatusFilterSchema = z.enum([
  "PENDING",
  "SENDING",
  "SENT",
  "FAILED",
])

export const EmailJobListQuerySchema = z.object({
  status: EmailJobStatusFilterSchema.optional(),
  formId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1).catch(1),
})

export const TestEmailSchema = z.object({
  to: z.string().email("Enter a valid email address."),
})
export type TestEmailInput = z.infer<typeof TestEmailSchema>

// Admin email-job list (Seven Admin Pages, Phase C, plan §3.6) —
// the Jobs page Queue section. `status` is the list's own tab split
// (All / Pending / Sending / Failed — no Sent tab in v1); `type`
// mirrors the owner list's job-type filter; `ownerSearch` is free
// text on the job owner (email or name). Same page shape as the
// owner list (page 1-based, 20 per page, server-side).
export const AdminEmailJobStatusTabSchema = z.enum([
  "all",
  "pending",
  "sending",
  "failed",
])

export const AdminEmailJobListQuerySchema = z.object({
  status: AdminEmailJobStatusTabSchema.default("all"),
  type: z
    .enum([
      "SUBMISSION_NOTIFICATION",
      "EMAIL_VERIFICATION",
      "PASSWORD_RESET",
      "DIGEST",
      "SUBMISSION_REPLY",
      "TEST_EMAIL",
    ])
    .optional(),
  ownerSearch: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1).catch(1),
})
export type AdminEmailJobListQuery = z.infer<
  typeof AdminEmailJobListQuerySchema
>
