import { z } from "zod"

// Public submission API request body (POST /api/public/v1/submit).
// `userId` + `formId` are the PUBLIC identifiers shown on the form detail
// page — no secrets travel in the browser bundle.

export const HONEYPOT_FIELD = "_sendcms_honeypot"

export const SubmitBodySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  formId: z.string().min(1, "formId is required"),
  fields: z
    .record(z.string(), z.unknown())
    .refine((f) => Object.keys(f).length <= 50, {
      message: "Too many fields (max 50)",
    }),
  // Honeypot: the SDK renders this hidden input; humans leave it empty.
  [HONEYPOT_FIELD]: z.string().optional(),
  // Client-generated idempotency key; a repeat with the same key returns
  // the original submission instead of creating a second one.
  idempotencyKey: z.string().min(1).max(100).optional(),
  // Page the visitor submitted from (informational; the Origin header is
  // what authorizes the submission, never this value).
  pageUrl: z.string().max(2048).optional(),
  // Cloudflare Turnstile token, only when the form has Turnstile on.
  turnstileToken: z.string().min(1).optional(),
})

export type SubmitBodyInput = z.infer<typeof SubmitBodySchema>
