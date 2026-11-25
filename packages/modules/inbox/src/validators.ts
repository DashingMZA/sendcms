import { z } from "zod"
import { BrowserKeyOptionsSchema } from "@sendcms/ai-settings/validators"

// Inbox dashboard (Phase 7) — list filters and status actions.

export const InboxTabSchema = z.enum([
  "all",
  "unread",
  "read",
  "starred",
  "archived",
  "spam",
])
export type InboxTabInput = z.infer<typeof InboxTabSchema>

export const InboxActionSchema = z.enum([
  "read",
  "unread",
  "star",
  "unstar",
  "archive",
  "restore",
  "spam",
  "not-spam",
])
export type InboxActionInput = z.infer<typeof InboxActionSchema>

export const UpdateSubmissionStatusSchema = z.object({
  action: InboxActionSchema,
})

export const BulkUpdateSubmissionsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  action: InboxActionSchema,
})

// SRC-104: the send-reply body, validated with Zod instead of the
// route's hand-rolled string checks. The caps (subject 200, body
// 2000) mirror the service's own limits in sendReplyToSubmission —
// the route used to accept unbounded strings and let the service
// 422 them as "Reply is too long."
export const SendReplySchema = z.object({
  subject: z.string().trim().min(1, "Subject is required.").max(200),
  body: z.string().trim().min(1, "Body is required.").max(2000),
})

export type SendReplyInput = z.infer<typeof SendReplySchema>

// SRC-104: the draft-reply body is exactly the shared browser-only
// key trio — no hand-rolled provider/key parsing in the route.
export const DraftReplySchema = BrowserKeyOptionsSchema

export type DraftReplyInput = z.infer<typeof DraftReplySchema>

// DSH-202: a YYYY-MM-DD string that is also a real calendar date.
// The old regex accepted impossible dates (2026-02-30, 2026-13-01),
// which reached Postgres as a `::timestamptz` cast and 500d. The
// component-wise round-trip rejects rolled-over dates (JS Date
// silently maps Feb 30 → Mar 2, so validity alone is not enough).
// Shared by the list-query schema below and the service guard in
// service.ts (direct callers bypass the route's validation).
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
  .refine(isValidCalendarDate, "Expected a valid calendar date (YYYY-MM-DD)")
  .optional()

/** Parses the inbox list query string. Unknown/invalid values fall back
    to the defaults instead of 400ing — a shared link with a bad tab
    still shows the inbox. */
export const InboxListQuerySchema = z.object({
  tab: InboxTabSchema.default("all").catch("all"),
  formId: z.string().min(1).optional(),
  originDomain: z.string().min(1).optional(),
  search: z.string().max(200).optional(),
  from: dateString,
  to: dateString,
  page: z.coerce.number().int().min(1).default(1).catch(1),
})
