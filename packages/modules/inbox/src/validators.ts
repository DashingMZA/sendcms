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
  // DB-048: `page` is capped at 1000 — the `.catch(1)` below swallows
  // an out-of-range page back to 1, so a deep offset can never reach
  // the raw-SQL list (and the service clamps direct callers too).
  page: z.coerce.number().int().min(1).max(1000).default(1).catch(1),
})

export type InboxListQuery = z.infer<typeof InboxListQuerySchema>

// SRC-124: resolve the inbox list query string to canonical params.
// The schema's `.catch()` fallbacks silently correct a bad `?tab=`
// or `?page=` (and unknown keys are stripped) — the page must not
// silently show the corrected list. Instead it redirects to the
// canonical URL: `needsRedirect` is true whenever the raw query
// differs from what the schema produced (an invalid value corrected,
// an unknown key dropped, a repeated key, or a wholly invalid query
// such as a bad `?from=` date). `canonicalSearch` is the corrected
// query string (defaults omitted), so the redirect target parses
// back to exactly these params — no redirect loop.
export function resolveInboxListParams(
  raw: Record<string, string | string[] | undefined>
): {
  params: InboxListQuery
  needsRedirect: boolean
  canonicalSearch: string
} {
  const flat: Record<string, string> = {}
  let droppedRepeated = false
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
    else if (value !== undefined) droppedRepeated = true
  }
  const parsed = InboxListQuerySchema.safeParse(flat)
  const params = parsed.success ? parsed.data : InboxListQuerySchema.parse({})
  let needsRedirect = droppedRepeated || !parsed.success
  if (parsed.success && !needsRedirect) {
    const known = [
      "tab",
      "formId",
      "originDomain",
      "search",
      "from",
      "to",
      "page",
    ]
    for (const [key, value] of Object.entries(flat)) {
      if (!known.includes(key)) {
        needsRedirect = true
        break
      }
      const corrected = params[key as keyof InboxListQuery]
      if (corrected === undefined || String(corrected) !== value) {
        needsRedirect = true
        break
      }
    }
  }
  const canonical = new URLSearchParams()
  if (params.tab !== "all") canonical.set("tab", params.tab)
  if (params.formId) canonical.set("formId", params.formId)
  if (params.originDomain) canonical.set("originDomain", params.originDomain)
  if (params.search) canonical.set("search", params.search)
  if (params.from) canonical.set("from", params.from)
  if (params.to) canonical.set("to", params.to)
  if (params.page !== 1) canonical.set("page", String(params.page))
  return { params, needsRedirect, canonicalSearch: canonical.toString() }
}
