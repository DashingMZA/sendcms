import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

// Auto-reply drafts (Phase 12, Step 4). The model call only — the
// orchestration (ownership, the aiEnabled opt-in, the send) lives in
// `@sendcms/inbox` + `@sendcms/notifications`. The owner reviews and
// edits the draft before anything is sent (ADR 0010): this function
// returns a draft, it never sends an email.

export const ReplyDraftSchema = z.object({
  /** A short subject line for the reply email. */
  subject: z.string().min(1).max(200),
  /** The reply body, plain text. */
  body: z.string().min(1).max(2000),
})

export type ReplyDraft = z.infer<typeof ReplyDraftSchema>

/** Asks the model to draft a reply to one submission. Returns the
    draft — the caller shows it to the owner for review and editing.
    Throws when the provider call fails. */
export async function draftReply({
  model,
  formName,
  submission,
}: {
  model: LanguageModel
  formName: string
  submission: {
    senderName: string | null
    senderEmail: string | null
    content: string
    receivedAt: Date
  }
}): Promise<ReplyDraft> {
  const from = submission.senderName ?? submission.senderEmail ?? "A visitor"
  const { object } = await generateObject({
    model,
    schema: ReplyDraftSchema,
    // One retry only (default is 2) — same reason as suggestFields:
    // an interactive call, and the dashboard proxy gives up after
    // ~30s while the SDK's 3-attempt backoff burns ~30s on an
    // overloaded model. A fast failure lets the owner retry at once.
    maxRetries: 1,
    prompt: [
      "You are drafting a reply email for a website owner to a visitor who filled in their contact form.",
      "Write a polite, helpful reply in plain language. Answer what the visitor asked when the message makes that possible; otherwise acknowledge their message and say the owner will follow up.",
      "Keep it short — a few sentences. Do not invent facts about the business, prices, or dates.",
      `Form: "${formName}"`,
      `From: ${from} (${submission.receivedAt.toISOString()})`,
      `Message: ${submission.content}`,
      "Reply with a subject line and a plain-text body.",
    ].join("\n"),
  })
  // Validate at the boundary too: a malformed model reply must never
  // reach the owner.
  return ReplyDraftSchema.parse(object)
}
