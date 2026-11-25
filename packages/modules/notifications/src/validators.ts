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
