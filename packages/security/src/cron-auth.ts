import { createHash, timingSafeEqual } from "node:crypto"

// Constant-time Bearer-token check (SRC-115 / EML-067). The cron
// route used a plain `header !== `Bearer ${secret}`` comparison:
// case-sensitive on the scheme (HTTP auth schemes are
// case-insensitive per RFC 9110 / RFC 6750, so a scheduler sending
// lowercase `bearer` 401'd) and not constant-time. This helper parses
// the scheme case-insensitively and compares the token in constant
// time: both sides are SHA-256 hashed first so `timingSafeEqual` (which
// requires equal-length inputs) never leaks the secret's length, and
// the comparison itself runs over fixed-length digests.
export function isValidBearerToken(
  header: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!header || !secret) return false
  const space = header.indexOf(" ")
  if (space === -1) return false
  const scheme = header.slice(0, space)
  const token = header.slice(space + 1).trim()
  if (scheme.toLowerCase() !== "bearer" || token.length === 0) {
    return false
  }
  const tokenHash = createHash("sha256").update(token).digest()
  const secretHash = createHash("sha256").update(secret).digest()
  return timingSafeEqual(tokenHash, secretHash)
}
