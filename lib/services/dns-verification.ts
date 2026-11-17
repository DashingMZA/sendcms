import { ApiError } from "@/lib/api/error"
import type { DomainVerificationMethod } from "@/generated/prisma/client"

// Ownership-proof checks for the three verification methods (Phase 3).
// DNS lookups go through DNS-over-HTTPS (portable on Workers, no raw DNS
// socket needed): Cloudflare first, Google as fallback. The HTTP methods
// (meta tag / verification file) fetch the owner's own site over HTTPS
// with an SSRF guard: the host must resolve to public IPs only.

const DOH_TIMEOUT_MS = 5000
const HTTP_TIMEOUT_MS = 5000
const HTTP_MAX_BYTES = 1024 * 1024

export type VerificationCheckResult =
  { ok: true } | { ok: false; reason: string }

export async function checkVerification(
  domain: string,
  method: DomainVerificationMethod,
  challenge: string
): Promise<VerificationCheckResult> {
  switch (method) {
    case "DNS_TXT":
      return checkDnsTxt(domain, challenge)
    case "META_TAG":
      return checkMetaTag(domain, challenge)
    case "FILE":
      return checkVerificationFile(domain, challenge)
  }
}

// ---------------------------------------------------------------------------
// DNS TXT (DNS-over-HTTPS)
// ---------------------------------------------------------------------------

type DohJson = {
  Status?: number
  Answer?: { type?: number; data?: string }[]
}

const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
]

async function dohTxtQuery(
  endpoint: string,
  hostname: string
): Promise<string[] | null> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=TXT`
  const res = await fetch(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!res.ok) return null
  const body = (await res.json()) as DohJson
  if (body.Status !== 0) return []
  const records: string[] = []
  for (const answer of body.Answer ?? []) {
    if (answer.type !== 16 || typeof answer.data !== "string") continue
    records.push(joinTxtSegments(answer.data))
  }
  return records
}

// A TXT record's data arrives as one or more quoted strings
// ("part1" "part2"); the value is their concatenation.
export function joinTxtSegments(data: string): string {
  const segments = data.match(/"([^"]*)"/g)
  if (!segments) return data
  return segments.map((s) => s.slice(1, -1)).join("")
}

export async function lookupTxtRecords(hostname: string): Promise<string[]> {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const records = await dohTxtQuery(endpoint, hostname)
      if (records !== null) return records
    } catch {
      // Resolver unreachable — try the next one.
    }
  }
  throw new ApiError(
    "DNS lookup failed — both DNS-over-HTTPS resolvers are unreachable",
    502
  )
}

async function checkDnsTxt(
  domain: string,
  challenge: string
): Promise<VerificationCheckResult> {
  const hostname = `_contact-verify.${domain}`
  const records = await lookupTxtRecords(hostname)
  if (records.some((r) => r.trim() === challenge)) return { ok: true }
  if (records.length === 0) {
    return {
      ok: false,
      reason: `No TXT record found at ${hostname} yet. DNS changes can take a few minutes to propagate.`,
    }
  }
  return {
    ok: false,
    reason: `TXT record at ${hostname} does not contain the challenge yet. Found ${records.length} record(s) with a different value.`,
  }
}

// ---------------------------------------------------------------------------
// HTTP methods (meta tag / verification file) — SSRF-guarded fetch
// ---------------------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  )
    return true
  const [first, second] = lower.split(".").map(Number)
  if (Number.isNaN(first)) return false
  if (first === 10 || first === 127 || first === 0) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  return false
}

async function lookupIpAddresses(hostname: string): Promise<string[]> {
  const ips: string[] = []
  for (const endpoint of DOH_ENDPOINTS) {
    for (const type of ["A", "AAAA"]) {
      try {
        const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`
        const res = await fetch(url, {
          headers: { Accept: "application/dns-json" },
          signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
        })
        if (!res.ok) continue
        const body = (await res.json()) as DohJson
        if (body.Status !== 0) continue
        for (const answer of body.Answer ?? []) {
          if (typeof answer.data === "string") ips.push(answer.data)
        }
      } catch {
        // Resolver unreachable — the next endpoint/type is tried.
      }
    }
    if (ips.length > 0) return ips
  }
  return ips
}

// Fetch a URL on the owner's own domain only: resolve the host first and
// refuse when it points at a private/loopback address (DNS-rebinding guard).
// Follows same-host redirects (e.g. apex → www) up to 3 hops.
async function fetchOwnSite(
  domain: string,
  path: string
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  const ips = await lookupIpAddresses(domain)
  if (ips.length === 0) {
    return { ok: false, reason: `Could not resolve ${domain}.` }
  }
  if (ips.some(isPrivateIp)) {
    return {
      ok: false,
      reason: `${domain} resolves to a private address — refusing to fetch it.`,
    }
  }
  let url = `https://${domain}${path}`
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { "User-Agent": "SendCMS-verification/1.0" },
      })
    } catch {
      return { ok: false, reason: `Could not reach https://${domain}${path}.` }
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")
      if (!location)
        return { ok: false, reason: `Redirect without a location from ${url}.` }
      const next = new URL(location, url)
      if (next.protocol !== "https:") {
        return {
          ok: false,
          reason: "Redirect leaves HTTPS — refusing to follow.",
        }
      }
      const host = next.hostname.toLowerCase().replace(/^www\./, "")
      if (host !== domain) {
        return {
          ok: false,
          reason: `Redirect leaves ${domain} — refusing to follow.`,
        }
      }
      url = next.toString()
      continue
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: `https://${domain}${path} returned HTTP ${res.status}.`,
      }
    }
    const body = await readCapped(res)
    return { ok: true, body }
  }
  return { ok: false, reason: "Too many redirects." }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > HTTP_MAX_BYTES) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

const META_TAG_RE =
  /<meta[^>]+name=["']sendcms-verification["'][^>]+content=["']([^"']+)["']/i
const META_TAG_RE_REVERSED =
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']sendcms-verification["']/i

export function extractMetaTagToken(html: string): string | null {
  return (
    html.match(META_TAG_RE)?.[1] ??
    html.match(META_TAG_RE_REVERSED)?.[1] ??
    null
  )
}

async function checkMetaTag(
  domain: string,
  challenge: string
): Promise<VerificationCheckResult> {
  const fetched = await fetchOwnSite(domain, "/")
  if (!fetched.ok) return fetched
  const token = extractMetaTagToken(fetched.body)
  if (token === null) {
    return {
      ok: false,
      reason: `No <meta name="sendcms-verification"> tag found on https://${domain}/ yet.`,
    }
  }
  if (token.trim() === challenge) return { ok: true }
  return {
    ok: false,
    reason:
      "The meta tag is present but its content does not match the challenge.",
  }
}

async function checkVerificationFile(
  domain: string,
  challenge: string
): Promise<VerificationCheckResult> {
  const path = "/.well-known/sendcms-verification.txt"
  const fetched = await fetchOwnSite(domain, path)
  if (!fetched.ok) return fetched
  if (fetched.body.trim() === challenge) return { ok: true }
  return {
    ok: false,
    reason: `https://${domain}${path} does not contain the challenge yet.`,
  }
}
