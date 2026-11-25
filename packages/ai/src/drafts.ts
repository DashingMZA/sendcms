import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

import {
  getLanguageModelId,
  toAiCallUsageWithCost,
  type AiCallUsage,
} from "./provider"
import {
  AI_INTERACTIVE_TIMEOUT_MS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
} from "./errors"
import { AI_MAX_DRAFT_EXCERPT_CHARS, truncateAiInput } from "./limits"
import { wrapUntrustedData } from "./untrusted"

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
    receives the token usage the provider reported, for attribution.
    The visitor message is truncated to AI_MAX_DRAFT_EXCERPT_CHARS
    (SRC-325); the call aborts after AI_INTERACTIVE_TIMEOUT_MS
    (SRC-311) with one retry (AIM-023). `timeoutMs` is test-only. */
export async function draftReply({
  model,
  formName,
  submission,
  onUsage,
  timeoutMs = AI_INTERACTIVE_TIMEOUT_MS,
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
  timeoutMs?: number
}): Promise<ReplyDraft> {
  const from = submission.senderName ?? submission.senderEmail ?? "A visitor"
  const { object, usage } = await generateObject({
    model,
    schema: ReplyDraftModelSchema,
    // One retry only (default is 2) — same reason as suggestFields:
    // an interactive call, and the dashboard proxy gives up after
    // ~30s while the SDK's 3-attempt backoff burns ~30s on an
    // overloaded model. A fast failure lets the owner retry at once.
    // AI_MAX_RETRIES (AIM-023) is that same 1, shared by all four
    // capabilities; the timeout above is what bounds a hung call.
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: AI_MAX_RETRIES,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS.draft,
    prompt: [
      "You are drafting a reply email for a website owner to a visitor who filled in their contact form.",
      "Write a polite, helpful reply in plain language. Answer what the visitor asked when the message makes that possible; otherwise acknowledge their message and say the owner will follow up.",
      "Keep it short — a few sentences. Do not invent facts about the business, prices, or dates.",
      `Form: "${formName}"`,
      `From: ${from} (${submission.receivedAt.toISOString()})`,
      // AIM-022: the visitor's message is untrusted data — delimited,
      // never pasted bare into the prompt.
      wrapUntrustedData(
        "Message",
        truncateAiInput(submission.content, AI_MAX_DRAFT_EXCERPT_CHARS)
      ),
      "Reply with a subject line and a plain-text body.",
    ].join("\n"),
  })
  onUsage?.(toAiCallUsageWithCost(getLanguageModelId(model), usage))
  // Validate at the boundary too: a malformed model reply must never
  // reach the owner.
  return ReplyDraftSchema.parse(object)
}
