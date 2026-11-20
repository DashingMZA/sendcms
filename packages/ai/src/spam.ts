import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

// AI spam re-scoring (Phase 12, Step 2). The model call only — the
// orchestration (which submissions to score, the daily cap, the
// status change) lives in `@sendcms/submissions`. The model sees the
// submission content (that is the point of scoring it), so callers
// must check the form's `aiEnabled` opt-in first and must never log
// the content (ADR 0010, Decision 4).

export const SpamVerdictSchema = z.object({
  /** 0 = definitely genuine, 100 = definitely spam. */
  score: z.number().int().min(0).max(100),
  /** One sentence, no submission content copied into it. */
  reason: z.string().max(200),
})

export type SpamVerdict = z.infer<typeof SpamVerdictSchema>

/** Score at or above this is spam. Overridable via AI_SPAM_THRESHOLD. */
export const DEFAULT_SPAM_THRESHOLD = 70

export function getSpamThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_SPAM_THRESHOLD)
  if (Number.isFinite(raw)) {
    return Math.min(100, Math.max(0, Math.trunc(raw)))
  }
  return DEFAULT_SPAM_THRESHOLD
}

/** Asks the model to score one submission. Returns the score and a
    short reason. Throws when the provider call fails — the caller
    decides whether to retry later or skip the submission. */
export async function rescoreSpam({
  model,
  formName,
  data,
}: {
  model: LanguageModel
  formName: string
  data: Record<string, unknown>
}): Promise<SpamVerdict> {
  const { object } = await generateObject({
    model,
    schema: SpamVerdictSchema,
    prompt: [
      "You are a spam filter for a website contact form.",
      "Score this submission from 0 (definitely a genuine message from a real person) to 100 (definitely spam).",
      "Spam means: unsolicited advertising, SEO or link-building schemes, phishing, bulk or irrelevant content, or gibberish meant to test the form.",
      "A genuine message is relevant to the site, written for the site owner, and asks or says something a real visitor would.",
      `Form: "${formName}"`,
      `Submission: ${JSON.stringify(data)}`,
      "Reply with a spam score and a one-sentence reason.",
    ].join("\n"),
  })
  // Validate at the boundary too: the SDK validates against the schema,
  // but a malformed model reply must never reach the status change.
  return SpamVerdictSchema.parse(object)
}
