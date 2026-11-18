import { z } from "zod"

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

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
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
