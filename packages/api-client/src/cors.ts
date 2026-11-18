// Shared origin helpers. `getEffectiveOrigin` reads the request Origin
// (falling back to the Referer) for the public submission API, and
// `corsHeaders` builds the CORS response headers. The legacy widget
// origin allowlist (`isOriginAllowed`) was removed with the comment system.
export function getEffectiveOrigin(req: Request): string | null {
  const origin = req.headers.get("origin")
  if (origin) return origin
  const referer = req.headers.get("referer")
  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      return null
    }
  }
  return null
}

export function normalizeOrigin(input: string): string {
  try {
    const raw = input.trim()
    if (raw === "*") return "*"
    const withProto = raw.match(/^https?:\/\//i) ? raw : `https://${raw}`
    return new URL(withProto).origin.toLowerCase()
  } catch {
    return input.trim().toLowerCase().replace(/\/+$/, "")
  }
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}
