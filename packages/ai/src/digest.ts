import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

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

export function getDigestIntervalHours(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.AI_DIGEST_INTERVAL_HOURS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return DEFAULT_DIGEST_INTERVAL_HOURS
}

/** Asks the model to summarize a form's new submissions. Returns the
    summary and highlights. Throws when the provider call fails — the
    caller decides whether to retry on the next poll or skip the form. */
export async function generateDigest({
  model,
  formName,
  submissions,
}: {
  model: LanguageModel
  formName: string
  submissions: DigestSubmissionInput[]
}): Promise<DigestSummary> {
  const lines = submissions.map((s, i) => {
    const from = s.senderName ?? s.senderEmail ?? "Unknown sender"
    return `${i + 1}. ${from} (${s.receivedAt.toISOString()}): ${s.snippet}`
  })
  const { object } = await generateObject({
    model,
    schema: DigestSummarySchema,
    prompt: [
      "You are writing a short digest email for a website owner about the new messages on their contact form.",
      "Summarize what the new submissions are about in two or three sentences, then list up to 5 short highlights (a notable sender, a recurring theme, an urgent request).",
      "Write for the site owner, in plain language. Do not invent submissions that are not listed.",
      `Form: "${formName}"`,
      `New submissions (${submissions.length}):`,
      ...lines,
    ].join("\n"),
  })
  // Validate at the boundary too: a malformed model reply must never
  // reach the email.
  return DigestSummarySchema.parse(object)
}
