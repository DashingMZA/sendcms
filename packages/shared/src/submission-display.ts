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
