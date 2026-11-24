import https from "node:https"
import type { IncomingMessage } from "node:http"
import { ApiError } from "@sendcms/shared"
import type { DomainVerificationMethod } from "@sendcms/database"

// Ownership-proof checks for the three verification methods (Phase 3).
// DNS lookups go through DNS-over-HTTPS (portable on Workers, no raw DNS
// socket needed): Cloudflare first, Google as fallback. The HTTP methods
// (meta tag / verification file) fetch the owner's own site over HTTPS
// with an SSRF guard: the host must resolve to public IPs only, and the
// fetch connects to the exact IP that was checked (pinned via
// node:https with SNI + Host header) so a DNS answer that flips between
// the check and the fetch cannot rebind the request to a private
// address (SEC-201 / SRC-232 / SEC-211).

const DOH_TIMEOUT_MS = 5000
const HTTP_TIMEOUT_MS = 5000
const HTTP_MAX_BYTES = 1024 * 1024

export type VerificationCheckResult =
  { ok: true } | { ok: false; reason: string }

/** Test seam for the SSRF-guarded fetch: `resolveIps` replaces the
    DNS-over-HTTPS lookup and `pinnedGet` replaces the pinned HTTPS
    request. Production callers omit `deps` and get the real ones. */
export type DnsVerificationDeps = {
  resolveIps?: (hostname: string) => Promise<string[]>
  pinnedGet?: (args: {
    hostname: string
    ip: string
    path: string
  }) => Promise<PinnedFetchResult>
}

export type PinnedFetchResult = {
  status: number
  location: string | null
  body: string
}

export async function checkVerification(
  domain: string,
  method: DomainVerificationMethod,
  challenge: string,
  deps?: DnsVerificationDeps
): Promise<VerificationCheckResult> {
  switch (method) {
    case "DNS_TXT":
      return checkDnsTxt(domain, challenge)
    case "META_TAG":
      return checkMetaTag(domain, challenge, deps)
    case "FILE":
      return checkVerificationFile(domain, challenge, deps)
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
  const hostname = `sendcms._domainkey.${domain}`
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

// IPv4-mapped IPv6 (`::ffff:127.0.0.1`, compressed or fully expanded,
// dotted-quad or hex tail) is normalised to the embedded IPv4 address
// before the range checks — without this the dotted-quad split below
// yields NaN and the address is wrongly classified as public.
export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase().trim()
  const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/)
  if (mapped) {
    const rest = mapped[1]
    if (rest.includes(".")) return isPrivateIp(rest)
    // Hex tail, e.g. ::ffff:7f00:1 — the last 32 bits are the IPv4 address.
    const groups = rest.split(":").filter(Boolean)
    if (groups.length >= 2) {
      const hi = parseInt(groups[groups.length - 2], 16)
      const lo = parseInt(groups[groups.length - 1], 16)
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return isPrivateIp(
          `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
        )
      }
    }
    // A ::ffff: address we cannot parse is refused, not trusted.
    return true
  }
  if (lower.includes(":")) {
    // IPv6 (not a mapped v4): loopback, unspecified, link-local
    // (fe80::/10), unique-local (fc00::/7).
    if (lower === "::1" || lower === "::") return true
    const firstGroup = parseInt(lower.split(":")[0], 16)
    if (!Number.isNaN(firstGroup)) {
      if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true
      if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true
    }
    return false
  }
  const [first, second, third] = lower.split(".").map(Number)
  if (Number.isNaN(first)) return false
  if (first === 10 || first === 127 || first === 0) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 192 && second === 0 && third === 0) return true
  if (first === 198 && (second === 18 || second === 19)) return true
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

// HTTPS GET to a pinned IP: the TCP/TLS connection goes to `ip`
// (never a fresh DNS resolution), SNI and the Host header carry the
// real hostname, and the certificate must match it
// (`rejectUnauthorized`). This is what closes the DNS-rebinding
// TOCTOU: the address the guard checked is the address fetched.
export async function pinnedHttpsGet(args: {
  hostname: string
  ip: string
  path: string
}): Promise<PinnedFetchResult> {
  const { hostname, ip, path } = args
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ip,
        port: 443,
        path,
        method: "GET",
        servername: hostname,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          Host: hostname,
          "User-Agent": "SendCMS-verification/1.0",
        },
      },
      (res: IncomingMessage) => {
        const location = res.headers.location ?? null
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400
        ) {
          // Redirect: the body is irrelevant — drain nothing, just close.
          res.destroy()
          resolve({ status: res.statusCode, location, body: "" })
          return
        }
        readCappedStream(res)
          .then((body) =>
            resolve({ status: res.statusCode ?? 0, location, body })
          )
          .catch(reject)
      }
    )
    req.on("error", reject)
    req.end()
  })
}

// Fetch a URL on the owner's own domain only: resolve the host first and
// refuse when it points at a private/loopback address, then fetch the
// exact IP that was checked. Every redirect hop re-resolves and
// re-checks, so a hop that newly resolves privately is refused too.
// Follows same-host redirects (e.g. apex → www) up to 3 hops.
async function fetchOwnSite(
  domain: string,
  path: string,
  deps?: DnsVerificationDeps
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  const resolveIps = deps?.resolveIps ?? lookupIpAddresses
  const pinnedGet = deps?.pinnedGet ?? pinnedHttpsGet
  // Resolve + pin one public IP for this hostname. Any private address
  // in the answer refuses the whole fetch.
  async function resolvePublicIp(
    hostname: string
  ): Promise<{ ok: true; ip: string } | { ok: false; reason: string }> {
    const ips = await resolveIps(hostname)
    if (ips.length === 0) {
      return { ok: false, reason: `Could not resolve ${hostname}.` }
    }
    if (ips.some(isPrivateIp)) {
      return {
        ok: false,
        reason: `${hostname} resolves to a private address — refusing to fetch it.`,
      }
    }
    return { ok: true, ip: ips[0] }
  }
  let url = `https://${domain}${path}`
  for (let hop = 0; hop <= 3; hop++) {
    const current = new URL(url)
    const hostname = current.hostname.toLowerCase()
    const pinned = await resolvePublicIp(hostname)
    if (!pinned.ok) return pinned
    let res: PinnedFetchResult
    try {
      res = await pinnedGet({
        hostname,
        ip: pinned.ip,
        path: `${current.pathname}${current.search}`,
      })
    } catch {
      return { ok: false, reason: `Could not reach https://${domain}${path}.` }
    }
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) {
        return { ok: false, reason: `Redirect without a location from ${url}.` }
      }
      const next = new URL(res.location, url)
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
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        reason: `https://${domain}${path} returned HTTP ${res.status}.`,
      }
    }
    return { ok: true, body: res.body }
  }
  return { ok: false, reason: "Too many redirects." }
}

// Reads at most `maxBytes` from a byte stream. The merged buffer is
// sized from the chunks actually kept, so an over-cap chunk leaves no
// trailing NUL padding in the body.
export async function readCappedStream(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number = HTTP_MAX_BYTES
): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const value of stream) {
    if (total + value.length > maxBytes) break
    chunks.push(value)
    total += value.length
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
  challenge: string,
  deps?: DnsVerificationDeps
): Promise<VerificationCheckResult> {
  const fetched = await fetchOwnSite(domain, "/", deps)
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
  challenge: string,
  deps?: DnsVerificationDeps
): Promise<VerificationCheckResult> {
  const path = "/sendcms-verification.txt"
  const fetched = await fetchOwnSite(domain, path, deps)
  if (!fetched.ok) return fetched
  if (fetched.body.trim() === challenge) return { ok: true }
  return {
    ok: false,
    reason: `https://${domain}${path} does not contain the challenge yet.`,
  }
}
