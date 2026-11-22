// Customer-country detection from request geo headers.
//
// Vercel sets `x-vercel-ip-country` and Cloudflare sets
// `cf-ipcountry` from the request IP. Returns the upper-cased ISO
// alpha-2 code, or null when no header is present (e.g. local dev) —
// the checkout page then shows a country select and the customer
// picks instead. "XX" (unknown) and "T1" (Tor) are treated as unknown.

export function countryFromHeaders(headers: Headers): string | null {
  const vercel = headers.get("x-vercel-ip-country")
  if (vercel && vercel.trim()) return vercel.trim().toUpperCase()
  const cloudflare = headers.get("cf-ipcountry")
  if (!cloudflare) return null
  const code = cloudflare.trim().toUpperCase()
  if (code === "XX" || code === "T1") return null
  return code
}
