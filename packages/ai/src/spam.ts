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
import { AI_MAX_SUBMISSION_CHARS, truncateAiInput } from "./limits"
import { neutraliseUntrustedJson, wrapUntrustedData } from "./untrusted"

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

/** Relaxed schema for the model call only. Gemini's structured output
    rejects the strict schema ("a constraint that has too many
    states"): an integer with min/max bounds is one of the causes it
    names. So the model gets a plain number + string, and
    `rescoreSpam` rounds/clamps the score and still validates the
    reply against the strict `SpamVerdictSchema` at the boundary. */
const SpamVerdictModelSchema = z.object({
  score: z.number(),
  reason: z.string(),
})

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
    decides whether to retry later or skip the submission. `onUsage`
    (optional) receives the token usage the provider reported, so the
    caller can attribute the call without changing this return value.
    The submission JSON is truncated to AI_MAX_SUBMISSION_CHARS
    (SRC-325) and the call aborts after AI_WORKER_TIMEOUT_MS
    (SRC-311) with one retry (AIM-023). `timeoutMs` is test-only. */
export async function rescoreSpam({
  model,
  formName,
  data,
  onUsage,
  timeoutMs = AI_WORKER_TIMEOUT_MS,
}: {
  model: LanguageModel
  formName: string
  data: Record<string, unknown>
  onUsage?: (usage: AiCallUsage | null) => void
  timeoutMs?: number
}): Promise<SpamVerdict> {
  const { object, usage } = await generateObject({
    model,
    schema: SpamVerdictModelSchema,
    abortSignal: AbortSignal.timeout(timeoutMs),
    maxRetries: AI_MAX_RETRIES,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS.spam,
    prompt: [
      "You are a spam filter for a website contact form.",
      "Score this submission from 0 (definitely a genuine message from a real person) to 100 (definitely spam).",
      "Spam means: unsolicited advertising, SEO or link-building schemes, phishing, bulk or irrelevant content, or gibberish meant to test the form.",
      "A genuine message is relevant to the site, written for the site owner, and asks or says something a real visitor would.",
      `Form: "${formName}"`,
      // AIM-022: the submission is untrusted visitor input — it is
      // delimited as data, and instruction-like lines are stripped
      // before scoring, so a payload cannot steer the classifier
      // that keeps spam out of the inbox.
      wrapUntrustedData(
        "Submission",
        truncateAiInput(
          JSON.stringify(neutraliseUntrustedJson(data)),
          AI_MAX_SUBMISSION_CHARS
        )
      ),
      "Reply with a spam score and a one-sentence reason.",
      // AIM-026: the schema promises the reason never copies
      // submission content — the model has to be told that, not
      // just the schema comment.
      "Do not copy any submission content into the reason.",
    ].join("\n"),
  })
  onUsage?.(toAiCallUsageWithCost(getLanguageModelId(model), usage))
  // Validate at the boundary too: the SDK validates against the
  // relaxed model schema, but a malformed model reply must never
  // reach the status change. Round + clamp first — the model may
  // return a float or a value outside 0–100, and the strict schema
  // requires an integer in range.
  return SpamVerdictSchema.parse({
    score: Math.min(100, Math.max(0, Math.round(object.score))),
    reason: object.reason,
  })
}
