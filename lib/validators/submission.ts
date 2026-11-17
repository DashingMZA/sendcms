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

// Top-level body keys for a form-encoded (no-JS) submission. Every
// other field becomes a submission field under `fields`.
const FORM_BODY_KEYS = new Set([
  "userId",
  "formId",
  HONEYPOT_FIELD,
  "idempotencyKey",
  "pageUrl",
  "turnstileToken",
])

/** Converts a form-encoded body (URL-encoded or multipart, e.g. a
    native <form action="…/api/public/v1/submit" method="POST"> with no
    JavaScript) into the same shape the JSON API takes. Repeated keys
    (checkbox groups) become arrays; file values are dropped — the API
    takes text only. The result still goes through SubmitBodySchema. */
export function formDataToSubmitBody(
  formData: FormData
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const fields: Record<string, unknown> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue
    if (FORM_BODY_KEYS.has(key)) {
      body[key] = value
      continue
    }
    const existing = fields[key]
    if (existing === undefined) {
      fields[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      fields[key] = [existing, value]
    }
  }
  body.fields = fields
  return body
}
