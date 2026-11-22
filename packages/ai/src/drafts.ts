import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

import { toAiCallUsage, type AiCallUsage } from "./provider"

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

/** Relaxed schema for the model call only. Gemini's structured output
    rejects the strict schema ("a constraint that has too many
    states"): string length bounds are among the causes it names. So
    the model gets bare strings, and `draftReply` still validates the
    reply against the strict `ReplyDraftSchema` at the boundary. */
const ReplyDraftModelSchema = z.object({
  subject: z.string(),
  body: z.string(),
})

/** Asks the model to draft a reply to one submission. Returns the
    draft — the caller shows it to the owner for review and editing.
    Throws when the provider call fails. `onUsage` (optional)
    receives the token usage the provider reported, for attribution. */
export async function draftReply({
  model,
  formName,
  submission,
  onUsage,
}: {
  model: LanguageModel
  formName: string
  submission: {
    senderName: string | null
    senderEmail: string | null
    content: string
    receivedAt: Date
  }
  onUsage?: (usage: AiCallUsage | null) => void
}): Promise<ReplyDraft> {
  const from = submission.senderName ?? submission.senderEmail ?? "A visitor"
  const { object, usage } = await generateObject({
    model,
    schema: ReplyDraftModelSchema,
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
  onUsage?.(toAiCallUsage(usage))
  // Validate at the boundary too: a malformed model reply must never
  // reach the owner.
  return ReplyDraftSchema.parse(object)
}
