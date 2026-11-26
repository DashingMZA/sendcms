// Render-time length caps (EML-012). One hostile submission must not
// produce an unbounded email: a single field value is capped at
// 2,000 chars with an ellipsis, and a notification renders at most
// 100 fields (the rest are counted, never rendered). The template's
// "view in inbox" link is the escape hatch to the full submission.

export const MAX_EMAIL_FIELD_CHARS = 2_000
export const MAX_EMAIL_FIELDS = 100

/** Truncates one field value to the render cap, with an ellipsis.
    Short values pass through untouched. */
export function truncateFieldValue(value: string): string {
  if (value.length <= MAX_EMAIL_FIELD_CHARS) return value
  return `${value.slice(0, MAX_EMAIL_FIELD_CHARS)}…`
}
