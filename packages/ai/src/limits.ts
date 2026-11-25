// Input-size caps for AI prompts (Phase 16, Wave 8: SRC-325).
// Prompts embed caller data (a whole submission, a digest's
// snippets, a form description) with no bound — a huge submission
// could blow token limits or cost. Every capability function
// truncates its inputs to the documented maxima below, inside
// @sendcms/ai, so a caller that forgets to truncate is still safe.
// Truncation is a hard cut with an ellipsis marker, never silent:
// the model sees that the input was cut.
export const AI_MAX_SUBMISSION_CHARS = 8000
export const AI_MAX_DIGEST_SNIPPET_CHARS = 500
export const AI_MAX_DRAFT_EXCERPT_CHARS = 2000
export const AI_MAX_FORM_DESCRIPTION_CHARS = 2000

/** Hard-cuts `text` to `maxChars`, appending "…" when cut. */
export function truncateAiInput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
