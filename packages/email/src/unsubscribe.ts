import { createHmac, timingSafeEqual } from "node:crypto"

// Signed per-recipient unsubscribe URLs (EML-011). The token binds
// the recipient address (+ the form scope, when the mail is about one
// form) with an HMAC keyed by BETTER_AUTH_SECRET, so an unsubscribe
// link cannot be forged for another address. No database row is
// needed to mint a link — the token IS the proof, and the route
// verifies it before recording the suppression.
//
// Token format (base64url): `${email}\n${formId}\n${hmac}` where the
// HMAC covers `${email}\n${formId}`. A global unsubscribe (digests
// have no single form — the digest recipient is the form owner, so a
// digest link always carries its formId; a null formId means "every
// form") uses an empty formId segment.

function getSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET ?? ""
  if (!value) {
    throw new Error(
      "Cannot build an unsubscribe URL: BETTER_AUTH_SECRET is not set."
    )
  }
  return value
}

export function signUnsubscribeToken(
  email: string,
  formId: string | null,
  secret?: string
): string {
  const scope = formId ?? ""
  const payload = `${email}\n${scope}`
  const sig = createHmac("sha256", getSecret(secret))
    .update(payload, "utf8")
    .digest("hex")
  return Buffer.from(`${payload}\n${sig}`, "utf8").toString("base64url")
}

export function verifyUnsubscribeToken(
  token: string,
  secret?: string
): { email: string; formId: string | null } | null {
  let decoded: string
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8")
  } catch {
    return null
  }
  const parts = decoded.split("\n")
  if (parts.length !== 3) return null
  const [email, scope, sig] = parts
  if (!email || !email.includes("@")) return null
  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(
      createHmac("sha256", getSecret(secret))
        .update(`${email}\n${scope}`, "utf8")
        .digest("hex"),
      "utf8"
    )
    actual = Buffer.from(sig, "utf8")
  } catch {
    return null
  }
  if (expected.length !== actual.length) return null
  if (!timingSafeEqual(expected, actual)) return null
  return { email, formId: scope === "" ? null : scope }
}

export function apiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001"
  )
}

/** The signed unsubscribe URL for one recipient (+ form scope).
    Returns null when no signing secret is configured — callers then
    omit the link instead of emitting an unverifiable one. */
export function buildUnsubscribeUrl(
  email: string,
  formId: string | null,
  opts: { baseUrl?: string; secret?: string } = {}
): string | null {
  try {
    const token = signUnsubscribeToken(email, formId, opts.secret)
    const base = (opts.baseUrl ?? apiBaseUrl()).replace(/\/$/, "")
    return `${base}/api/public/v1/unsubscribe?token=${encodeURIComponent(token)}`
  } catch {
    return null
  }
}
