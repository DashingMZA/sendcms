import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

import {
  getLanguageModelId,
  toAiCallUsageWithCost,
  type AiCallUsage,
} from "./provider"
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
  AI_WORKER_TIMEOUT_MS,
} from "./errors"
import { AI_MAX_DIGEST_SNIPPET_CHARS, truncateAiInput } from "./limits"
import { wrapUntrustedData } from "./untrusted"

// AI inbox digest (Phase 12, Step 3). The model call only — the
// orchestration (which forms are due, the window, the enqueue) lives
// in `@sendcms/submissions`. The model sees the new submissions'
// content (that is the point of summarizing them), so callers must
// check the form's `aiEnabled` opt-in first and must never log the
// content (ADR 0010, Decision 4). The summary goes to the form owner
// only — their own inbox data.

export const DigestSummarySchema = z.object({
  /** Two or three sentences on what the new submissions are about. */
  summary: z.string().max(500),
  /** Up to 5 short highlights (a notable sender, a recurring theme). */
  highlights: z.array(z.string().max(200)).max(5),
})

export type DigestSummary = z.infer<typeof DigestSummarySchema>

/** Relaxed schema for the model call only. Gemini's structured output
    rejects the strict schema ("a constraint that has too many
    states"): string length bounds and nested array maxes are among
    the causes it names. So the model gets bare strings + an array,
    and `generateDigest` still validates the reply against the strict
    `DigestSummarySchema` at the boundary. */
const DigestSummaryModelSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
})

/** One digest item handed to the model — a short, pre-truncated view
    of a submission, not the full record. */
export type DigestSubmissionInput = {
  senderName: string | null
  senderEmail: string | null
  snippet: string
  receivedAt: Date
}

/** Hours between digests for a form. Overridable via
    AI_DIGEST_INTERVAL_HOURS (24 = daily, 168 = weekly). */
export const DEFAULT_DIGEST_INTERVAL_HOURS = 24

/** When the next digest is due for a form: `lastDigestAt` plus the
    interval, or null when no digest has ever been sent (the first
    digest is due on the next run, so there is no meaningful date to
    show — callers render "due on the next run" instead). Pure. */
export function getNextDigestAt(
  lastDigestAt: Date | null,
  intervalHours: number
): Date | null {
  if (!lastDigestAt) return null
  return new Date(lastDigestAt.getTime() + intervalHours * 3_600_000)
}

/** The plain (no-model) digest summary (Phase 16, EML-093): the
    digest is a notification feature, so a form without AI — or
    whose model cannot be resolved — still gets a digest, just
    without an AI-written summary. The summary states the count and
    the highlights name the senders; nothing is invented. Pure. */
export function buildPlainDigestSummary(
  formName: string,
  submissions: DigestSubmissionInput[]
): DigestSummary {
  const count = submissions.length
  const summary =
    count === 1
      ? `1 new submission on ${formName}.`
      : `${count} new submissions on ${formName}.`
  const highlights = submissions.slice(0, 5).map((s) => {
    const from = s.senderName ?? s.senderEmail ?? "Unknown sender"
    return `${from}: ${s.snippet}`
  })
  return { summary, highlights }
}

export function getDigestIntervalHours(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AI_DIGEST_INTERVAL_HOURS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return DEFAULT_DIGEST_INTERVAL_HOURS
}

/** Asks the model to summarize a form's new submissions. Returns the
    summary and highlights. Throws when the provider call fails — the
    caller decides whether to retry on the next poll or skip the form.
    `onUsage` (optional) receives the token usage the provider
    reported, for attribution. Snippets are truncated to
    AI_MAX_DIGEST_SNIPPET_CHARS inside this function (SRC-325), so a
    caller that forgets to truncate cannot blow the token budget.
    The call aborts after AI_WORKER_TIMEOUT_MS (SRC-311) with one
    retry (AIM-023). `timeoutMs` is test-only. */
export async function generateDigest({
  model,
  formName,
  submissions,
  onUsage,
  timeoutMs = AI_WORKER_TIMEOUT_MS,
}: {
  model: LanguageModel
  formName: string
  submissions: DigestSubmissionInput[]
  onUsage?: (usage: AiCallUsage | null) => void
  timeoutMs?: number
}): Promise<DigestSummary> {
  const lines = submissions.map((s, i) => {
    const from = s.senderName ?? s.senderEmail ?? "Unknown sender"
    return `${i + 1}. ${from} (${s.receivedAt.toISOString()}): ${truncateAiInput(s.snippet, AI_MAX_DIGEST_SNIPPET_CHARS)}`
  })
  const { object, usage } = await generateObject({
    model,
    schema: DigestSummaryModelSchema,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: AI_MAX_RETRIES,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS.digest,
    prompt: [
      "You are writing a short digest email for a website owner about the new messages on their contact form.",
      "Summarize what the new submissions are about in two or three sentences, then list up to 5 short highlights (a notable sender, a recurring theme, an urgent request).",
      "Write for the site owner, in plain language. Do not invent submissions that are not listed.",
      `Form: "${formName}"`,
      // AIM-022: the snippets are untrusted visitor content —
      // delimited as data, never pasted bare into the prompt.
      wrapUntrustedData(
        `New submissions (${submissions.length})`,
        lines.join("\n")
      ),
    ].join("\n"),
  })
  onUsage?.(toAiCallUsageWithCost(getLanguageModelId(model), usage))
  // Validate at the boundary too: a malformed model reply must never
  // reach the email.
  return DigestSummarySchema.parse(object)
}
