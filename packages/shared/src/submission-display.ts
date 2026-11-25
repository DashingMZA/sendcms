// Pure display helpers for submissions — shared by the inbox service
// (server) and the inbox components (client). No database or Next.js
// imports here, so it is safe to import from client components.

/** Sender details pulled out of the submission's field values. Keys are
    matched case-insensitively; anything else falls back to null. */
export function getSubmissionSender(data: unknown): {
  name: string | null
  email: string | null
} {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { name: null, email: null }
  }
  const entries = Object.entries(data as Record<string, unknown>)
  const findString = (...keys: string[]): string | null => {
    for (const [key, value] of entries) {
      if (keys.includes(key.toLowerCase()) && typeof value === "string") {
        const trimmed = value.trim()
        if (trimmed) return trimmed
      }
    }
    return null
  }
  return {
    name: findString("name", "fullname", "full name"),
    email: findString("email", "e-mail"),
  }
}

/** The message excerpt for AI use: the "message" field when there
    is one, else the longest text value — the FULL text up to
    `maxChars`, NOT the 80-char UI preview. AIM-019: the draft and
    digest paths used to pass previewSubmissionText (an 80-char
    display helper) as the model's entire view of the message, so a
    reply was drafted from the first sentence of a long message.
    The 80-char preview stays a UI display concern; AI input uses
    this helper with its own budget (2000 chars for drafts, 500 for
    digest snippets). */
export function aiSubmissionExcerpt(data: unknown, maxChars = 2000): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "—"
  }
  const values = Object.entries(data as Record<string, unknown>)
  const message = values.find(
    ([key, value]) =>
      key.toLowerCase() === "message" && typeof value === "string"
  )
  const pick = message ?? values.find(([, value]) => typeof value === "string")
  if (!pick) return "—"
  const text = String(pick[1])
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** The message preview: the "message" field when there is one, else
    the longest text value. */
export function previewSubmissionText(data: unknown): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "—"
  }
  const values = Object.entries(data as Record<string, unknown>)
  const message = values.find(
    ([key, value]) =>
      key.toLowerCase() === "message" && typeof value === "string"
  )
  const pick = message ?? values.find(([, value]) => typeof value === "string")
  if (!pick) return "—"
  const text = String(pick[1])
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}
