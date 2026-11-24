import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Prisma, RateLimitScope, db } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"

const logger = createLogger("rate-limit")

// ─── Limits ─────────────────────────────────────────────────────────────

// Admin-API + auth sign-in rate limits (Admin Control Plane, Phase 9;
// closes ADR 0008 §6). The numbers live in the workspace-root
// `config/config.json` (the repo's feature-flag file — see AGENTS.md:
// "All new config goes here, not .env or hardcoded"):
//
//   {
//     "platform": { "emergency": false },
//     "rateLimits": {
//       "adminApi": { "perMinute": 600, "perHour": 10000 },
//       "authSignIn": { "perMinutePerIp": 20, "perMinutePerEmail": 10 }
//     }
//   }
//
// The defaults below apply when the file is missing, unparsable, or a
// value is not a positive integer. They are deliberately generous —
// these limits are anti-abuse, not quotas: an admin dashboard page
// load fires a dozen API calls, and a compromised account must not be
// able to hammer the API forever, but no legitimate admin should ever
// trip them. Compare: MCP allows 120/min + 2000/hour per key, the
// public submit 10/min + 100/hour per IP (both much tighter, because
// those endpoints are unauthenticated).
export const DEFAULT_ADMIN_API_MINUTE_LIMIT = 600
export const DEFAULT_ADMIN_API_HOUR_LIMIT = 10000
export const DEFAULT_AUTH_SIGNIN_MINUTE_PER_IP_LIMIT = 20
export const DEFAULT_AUTH_SIGNIN_MINUTE_PER_EMAIL_LIMIT = 10

export type RateLimitConfig = {
  adminApi: { perMinute: number; perHour: number }
  authSignIn: { perMinutePerIp: number; perMinutePerEmail: number }
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  adminApi: {
    perMinute: DEFAULT_ADMIN_API_MINUTE_LIMIT,
    perHour: DEFAULT_ADMIN_API_HOUR_LIMIT,
  },
  authSignIn: {
    perMinutePerIp: DEFAULT_AUTH_SIGNIN_MINUTE_PER_IP_LIMIT,
    perMinutePerEmail: DEFAULT_AUTH_SIGNIN_MINUTE_PER_EMAIL_LIMIT,
  },
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

// Pure parse (exported for tests): unknown JSON → a complete config,
// any missing/invalid field falling back to its default. Never throws.
export function parseRateLimitConfig(value: unknown): RateLimitConfig {
  const root =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  const rateLimits =
    typeof root.rateLimits === "object" && root.rateLimits !== null
      ? (root.rateLimits as Record<string, unknown>)
      : {}
  const adminApi =
    typeof rateLimits.adminApi === "object" && rateLimits.adminApi !== null
      ? (rateLimits.adminApi as Record<string, unknown>)
      : {}
  const authSignIn =
    typeof rateLimits.authSignIn === "object" && rateLimits.authSignIn !== null
      ? (rateLimits.authSignIn as Record<string, unknown>)
      : {}
  return {
    adminApi: {
      perMinute: positiveInt(
        adminApi.perMinute,
        DEFAULT_RATE_LIMIT_CONFIG.adminApi.perMinute
      ),
      perHour: positiveInt(
        adminApi.perHour,
        DEFAULT_RATE_LIMIT_CONFIG.adminApi.perHour
      ),
    },
    authSignIn: {
      perMinutePerIp: positiveInt(
        authSignIn.perMinutePerIp,
        DEFAULT_RATE_LIMIT_CONFIG.authSignIn.perMinutePerIp
      ),
      perMinutePerEmail: positiveInt(
        authSignIn.perMinutePerEmail,
        DEFAULT_RATE_LIMIT_CONFIG.authSignIn.perMinutePerEmail
      ),
    },
  }
}

let rateLimitConfigCache: {
  config: RateLimitConfig
  loadedAt: number
} | null = null

// Config reload interval (SRC-327): re-read config/config.json at
// most every 60 seconds, so a limit change takes effect without a
// restart while the file is not re-read on every request.
export const RATE_LIMIT_CONFIG_CACHE_TTL_MS = 60_000

export function resetRateLimitConfigCache(): void {
  rateLimitConfigCache = null
}

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// Directory of this module file. The workspace root is resolved from
// here as well as from process.cwd() (DOC-018): in a deployed server
// the working directory is the app directory, not the workspace root,
// so the pnpm-workspace.yaml marker is not discoverable from cwd and
// the old reader silently fell back to defaults — with no error or
// log. Resolving from the module file keeps the configured limits in
// effect wherever the process starts.
const moduleDir = dirname(fileURLToPath(import.meta.url))

// Resolves config/config.json, preferring the workspace root found
// from the working directory and falling back to the root found from
// this module file's location. Returns the resolved path and whether
// the module-file fallback was used, or null when neither walk finds
// the workspace marker or the config file.
function resolveConfigPath(): {
  path: string
  viaModuleFile: boolean
} | null {
  for (const [startDir, viaModuleFile] of [
    [process.cwd(), false],
    [moduleDir, true],
  ] as const) {
    const root = findWorkspaceRoot(startDir)
    if (!root) continue
    const path = join(root, "config", "config.json")
    if (existsSync(path)) return { path, viaModuleFile }
  }
  return null
}

// Reads config/config.json, re-reading at most every
// RATE_LIMIT_CONFIG_CACHE_TTL_MS (SRC-327): a limit change takes
// effect without a restart (within a minute), while a missing file,
// bad JSON, or missing key all mean "use the defaults" — the limiter
// must never fail because its config is unreadable; the fail-open
// rule below covers the rest. The fallback is LOUD, not silent
// (DOC-018): when the file cannot be found from the working
// directory, or cannot be read at all, a warning names the values
// that fell back to defaults, so an operator can see the platform is
// running on defaults.
export function readRateLimitConfig(now: Date = new Date()): RateLimitConfig {
  if (
    rateLimitConfigCache &&
    now.getTime() - rateLimitConfigCache.loadedAt <
      RATE_LIMIT_CONFIG_CACHE_TTL_MS
  ) {
    return rateLimitConfigCache.config
  }
  let config = DEFAULT_RATE_LIMIT_CONFIG
  const resolved = resolveConfigPath()
  if (!resolved) {
    logger.warn("config/config.json not found; using default rate limits", {
      cwd: process.cwd(),
      defaults: DEFAULT_RATE_LIMIT_CONFIG,
    })
  } else {
    if (resolved.viaModuleFile) {
      logger.warn(
        "config/config.json not found from working directory; resolved relative to package file",
        { cwd: process.cwd(), configPath: resolved.path }
      )
    }
    try {
      const raw = readFileSync(resolved.path, "utf8")
      config = parseRateLimitConfig(JSON.parse(raw) as unknown)
    } catch {
      logger.warn("config/config.json unreadable; using default rate limits", {
        configPath: resolved.path,
        defaults: DEFAULT_RATE_LIMIT_CONFIG,
      })
      config = DEFAULT_RATE_LIMIT_CONFIG
    }
  }
  rateLimitConfigCache = { config, loadedAt: now.getTime() }
  return config
}

// The per-IP bucket for one auth check (SRC-327): when no client IP
// could be resolved, there is NO shared `ip:unknown` bucket —
// unknown-IP callers must not share one bucket, where one flood
// locks out every other unidentified caller. Callers with an actor
// key (email) are keyed by that instead; callers with neither an IP
// nor an actor key fall back to a per-endpoint bucket (see
// checkAuthUnknownBucket below), which is the only key left. Returns
// null when the bucket is skipped (the caller proceeds to the next
// check), otherwise the limiter's verdict.
async function checkAuthIpBucket(input: {
  ip?: string | null
  subject: string
  minuteLimit: number
  now?: Date
}): Promise<RateLimitResult | null> {
  const ip = input.ip?.trim() || null
  if (!ip) return null
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: input.subject,
    minuteLimit: input.minuteLimit,
    hourLimit: null,
    now: input.now,
  })
}

// Last-resort bucket for auth requests with no IP and no actor key
// (reset-password and OAuth initiation carry no email): one bucket
// per endpoint kind, so a flood on one endpoint cannot exhaust
// another endpoint's budget. This is the ONLY shared bucket left —
// every caller that can be keyed by IP or email is keyed by that
// instead.
async function checkAuthUnknownBucket(input: {
  subject: string
  minuteLimit: number
  now?: Date
}): Promise<RateLimitResult> {
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: input.subject,
    minuteLimit: input.minuteLimit,
    hourLimit: null,
    now: input.now,
  })
}

// ─── Windows ────────────────────────────────────────────────────────────

// UTC minute/hour window starts (UTC, not local time: the MCP limiter
// uses local-time window starts, which splits one wall-clock minute
// into two buckets when servers run in different timezones).
function startOfUtcMinute(at: Date): Date {
  const minute = new Date(at)
  minute.setUTCHours(minute.getUTCHours(), minute.getUTCMinutes(), 0, 0)
  return minute
}

function startOfUtcHour(at: Date): Date {
  const hour = new Date(at)
  hour.setUTCHours(hour.getUTCHours(), 0, 0, 0)
  return hour
}

export type RateLimitResult = {
  /** False when the caller is over either limit. */
  allowed: boolean
  /** Seconds until the blocking window ends, when denied. */
  retryAfterSeconds?: number
  minuteCount: number
  hourCount: number
}

type BucketRow = {
  minuteCount: number
  hourCount: number
  minuteWindowStart: Date
  hourWindowStart: Date
}

// One atomic statement: insert the bucket on first use, otherwise
// advance the counters, rolling a window over when its start has
// moved. A single statement means concurrent requests cannot overshoot
// the limit (unlike the MCP limiter's read-then-upsert, which can
// overshoot by one under concurrency — acceptable there, but the admin
// limiter is specified atomic). The request IS counted even when it
// ends up denied: the count keeps growing inside the window, but the
// window still expires on schedule, so the denial lifts at the same
// time it would have otherwise.
//
// Sliding-window minute (SEC-205): a plain fixed window resets to 1
// at the minute boundary, so limit requests just before the boundary
// plus limit requests just after it pass — ~2x the budget inside one
// rolling minute. When the minute rolls to the *adjacent* minute, the
// new count carries a decayed share of the previous minute's count:
// `1 + floor(prevCount * carryWeight)`, where carryWeight is the
// fraction of the previous minute still inside a rolling 60-second
// window at the request's time (1.0 at :00, ~0.0 at :59). A roll after
// a gap of two minutes or more carries nothing. The hour window stays
// fixed — the minute window is the burst budget that matters here.
// NOTE: the `${carryWeight}::double precision` cast is load-bearing —
// without it Postgres infers the bound JS number as integer from the
// `int * $n` expression and rejects fractional weights (22P02),
// which fails the whole upsert open (verified live 2026-11-24).
async function incrementBucket(
  scope: RateLimitScope,
  subject: string,
  minuteStart: Date,
  hourStart: Date,
  carryWeight: number
): Promise<BucketRow> {
  const rows = await db.$queryRaw<BucketRow[]>(Prisma.sql`
    INSERT INTO "RateLimitBucket"
      ("id", "scope", "subject", "minuteWindowStart", "minuteCount", "hourWindowStart", "hourCount", "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid(), ${scope}::"RateLimitScope", ${subject}, ${minuteStart}, 1, ${hourStart}, 1, NOW(), NOW())
    ON CONFLICT ("scope", "subject") DO UPDATE SET
      "minuteCount" = CASE
        WHEN "RateLimitBucket"."minuteWindowStart" = EXCLUDED."minuteWindowStart"
        THEN "RateLimitBucket"."minuteCount" + 1
        WHEN EXCLUDED."minuteWindowStart" - "RateLimitBucket"."minuteWindowStart" = INTERVAL '60 seconds'
        THEN 1 + CAST(FLOOR("RateLimitBucket"."minuteCount" * ${carryWeight}::double precision) AS INTEGER)
        ELSE 1
      END,
      "minuteWindowStart" = EXCLUDED."minuteWindowStart",
      "hourCount" = CASE
        WHEN "RateLimitBucket"."hourWindowStart" = EXCLUDED."hourWindowStart"
        THEN "RateLimitBucket"."hourCount" + 1
        ELSE 1
      END,
      "hourWindowStart" = EXCLUDED."hourWindowStart",
      "updatedAt" = NOW()
    RETURNING "minuteCount", "hourCount", "minuteWindowStart", "hourWindowStart"
  `)
  const row = rows[0]
  if (!row) throw new Error("Rate-limit upsert returned no row.")
  return row
}

function secondsUntil(windowStart: Date, windowMs: number, now: Date): number {
  return Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)
  )
}

// Generic sliding-window-minute + fixed-window-hour check: minute +
// hour buckets for one (scope, subject) pair. `hourLimit` null skips
// the hour window (auth sign-in is minute-only). FAIL-OPEN: any limiter
// error (DB down, bad SQL, unexpected row) is logged and the request
// is allowed — a broken limiter must never lock the owner out of their
// own admin (ADR 0008's explicit warning).
//
// Layered-flow note: this module is the rate limiter's documented
// exception to "only services import `@sendcms/database`" (like the
// audit writer in the same package) — it exists so the atomic
// counting lives in one place, and it is called only from services
// and the api app's route helper.
export async function checkRateLimit(input: {
  scope: RateLimitScope
  subject: string
  minuteLimit: number
  hourLimit?: number | null
  now?: Date
}): Promise<RateLimitResult> {
  const now = input.now ?? new Date()
  const minuteStart = startOfUtcMinute(now)
  const hourStart = startOfUtcHour(now)
  // Fraction of the previous minute still inside a rolling 60-second
  // window at `now`: 1.0 at :00, decaying linearly to ~0.0 at :59.
  // Clamped — a clock-skewed `now` must never produce a negative or
  // >1 carry.
  const elapsedSeconds = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000
  const carryWeight = Math.min(1, Math.max(0, 1 - elapsedSeconds / 60))
  try {
    const row = await incrementBucket(
      input.scope,
      input.subject,
      minuteStart,
      hourStart,
      carryWeight
    )
    if (row.minuteCount > input.minuteLimit) {
      return {
        allowed: false,
        retryAfterSeconds: secondsUntil(minuteStart, 60_000, now),
        minuteCount: row.minuteCount,
        hourCount: row.hourCount,
      }
    }
    if (input.hourLimit != null && row.hourCount > input.hourLimit) {
      return {
        allowed: false,
        retryAfterSeconds: secondsUntil(hourStart, 3_600_000, now),
        minuteCount: row.minuteCount,
        hourCount: row.hourCount,
      }
    }
    return {
      allowed: true,
      minuteCount: row.minuteCount,
      hourCount: row.hourCount,
    }
  } catch (error) {
    logger.error("rate limit check failed, allowing request", {
      error,
      scope: input.scope,
      subject: input.subject,
    })
    return { allowed: true, minuteCount: 0, hourCount: 0 }
  }
}

// Admin API: one bucket per authenticated user ("user:<id>"), falling
// back to the client IP when no user is known (an unauthenticated
// caller — the route still 401s, but the bucket keeps a flood of
// anonymous hits from ever reaching the per-user counters). With
// neither a user nor an IP there is nothing to key on, so the check
// passes (SRC-327: no shared `ip:unknown` bucket).
export async function checkAdminApiRateLimit(input: {
  userId?: string | null
  ip?: string | null
  now?: Date
}): Promise<RateLimitResult> {
  const config = readRateLimitConfig(input.now)
  if (input.userId) {
    return checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: `user:${input.userId}`,
      minuteLimit: config.adminApi.perMinute,
      hourLimit: config.adminApi.perHour,
      now: input.now,
    })
  }
  const ip = input.ip?.trim() || null
  if (!ip) return { allowed: true, minuteCount: 0, hourCount: 0 }
  return checkRateLimit({
    scope: RateLimitScope.ADMIN_API,
    subject: `ip:${ip}`,
    minuteLimit: config.adminApi.perMinute,
    hourLimit: config.adminApi.perHour,
    now: input.now,
  })
}

// Auth sign-in: TWO buckets, both must pass — per-IP (one address
// hammering many accounts) and per-email (many addresses hammering
// one account). The email bucket is only checked when an email was
// supplied (a body that fails to parse still gets the IP bucket);
// with no IP and no email, the per-endpoint unknown bucket applies
// (SRC-327). Returns the first denial, so the caller reports one
// Retry-After.
export async function checkAuthSignInRateLimit(input: {
  ip?: string | null
  email?: string | null
  now?: Date
}): Promise<RateLimitResult> {
  const config = readRateLimitConfig(input.now)
  const email = input.email?.trim().toLowerCase()
  const ipResult = await checkAuthIpBucket({
    ip: input.ip,
    subject: `ip:${input.ip?.trim()}`,
    minuteLimit: config.authSignIn.perMinutePerIp,
    now: input.now,
  })
  if (ipResult && !ipResult.allowed) return ipResult
  if (!ipResult && !email) {
    return checkAuthUnknownBucket({
      subject: "ip:unknown",
      minuteLimit: config.authSignIn.perMinutePerIp,
      now: input.now,
    })
  }
  if (!email) return ipResult ?? { allowed: true, minuteCount: 0, hourCount: 0 }
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `email:${email}`,
    minuteLimit: config.authSignIn.perMinutePerEmail,
    hourLimit: null,
    now: input.now,
  })
}

// Auth sign-up (SEC-008 / SEC-203): the same per-IP + per-email shape
// as sign-in, on separate subjects so sign-up attempts never consume
// the sign-in budget (and vice versa). Limits reuse the authSignIn
// config values — no new config keys (the config reader is owned by
// the DOC-018 fix). No IP + no email → the per-endpoint unknown
// bucket (SRC-327).
export async function checkAuthSignUpRateLimit(input: {
  ip?: string | null
  email?: string | null
  now?: Date
}): Promise<RateLimitResult> {
  const config = readRateLimitConfig(input.now)
  const email = input.email?.trim().toLowerCase()
  const ipResult = await checkAuthIpBucket({
    ip: input.ip,
    subject: `signup-ip:${input.ip?.trim()}`,
    minuteLimit: config.authSignIn.perMinutePerIp,
    now: input.now,
  })
  if (ipResult && !ipResult.allowed) return ipResult
  if (!ipResult && !email) {
    return checkAuthUnknownBucket({
      subject: "signup-ip:unknown",
      minuteLimit: config.authSignIn.perMinutePerIp,
      now: input.now,
    })
  }
  if (!email) return ipResult ?? { allowed: true, minuteCount: 0, hourCount: 0 }
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `signup-email:${email}`,
    minuteLimit: config.authSignIn.perMinutePerEmail,
    hourLimit: null,
    now: input.now,
  })
}

// Auth email actions (SEC-008 / EML-003): per-IP + per-email buckets
// for the endpoints that send mail — password reset, verification
// mail, OAuth initiation. `kind` namespaces the subjects so each
// action has its own budget: "reset" (forget-password /
// reset-password), "verify" (send-verification-email), "social"
// (sign-in/social, sign-up/social). The email bucket is only checked
// when an email was supplied; reset-password and social initiation
// carry no email, so they get the IP bucket only.
export type AuthEmailRateLimitKind = "reset" | "verify" | "social"

export async function checkAuthEmailRateLimit(input: {
  ip?: string | null
  email?: string | null
  kind?: AuthEmailRateLimitKind
  now?: Date
}): Promise<RateLimitResult> {
  const kind = input.kind ?? "reset"
  const config = readRateLimitConfig(input.now)
  const email = input.email?.trim().toLowerCase()
  const ipResult = await checkAuthIpBucket({
    ip: input.ip,
    subject: `${kind}-ip:${input.ip?.trim()}`,
    minuteLimit: config.authSignIn.perMinutePerIp,
    now: input.now,
  })
  if (ipResult && !ipResult.allowed) return ipResult
  if (!ipResult && !email) {
    return checkAuthUnknownBucket({
      subject: `${kind}-ip:unknown`,
      minuteLimit: config.authSignIn.perMinutePerIp,
      now: input.now,
    })
  }
  if (!email) return ipResult ?? { allowed: true, minuteCount: 0, hourCount: 0 }
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `${kind}-email:${email}`,
    minuteLimit: config.authSignIn.perMinutePerEmail,
    hourLimit: null,
    now: input.now,
  })
}

// Email-sending routes (EML-003): test-email and send-reply are
// authenticated, so they are keyed per-user (one account flooding)
// plus per-resource (one form / one submission hammered). The limits
// are constants, not config — these are anti-abuse budgets for
// single actions, and the config reader is owned by the DOC-018 fix.
export const DEFAULT_TEST_EMAIL_PER_MINUTE_PER_USER = 10
export const DEFAULT_TEST_EMAIL_PER_MINUTE_PER_FORM = 10
export const DEFAULT_SEND_REPLY_PER_MINUTE_PER_USER = 10
export const DEFAULT_SEND_REPLY_PER_MINUTE_PER_SUBMISSION = 5

export async function checkTestEmailRateLimit(input: {
  userId: string
  formId: string
  now?: Date
}): Promise<RateLimitResult> {
  const userResult = await checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `test-email-user:${input.userId}`,
    minuteLimit: DEFAULT_TEST_EMAIL_PER_MINUTE_PER_USER,
    hourLimit: null,
    now: input.now,
  })
  if (!userResult.allowed) return userResult
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `test-email-form:${input.formId}`,
    minuteLimit: DEFAULT_TEST_EMAIL_PER_MINUTE_PER_FORM,
    hourLimit: null,
    now: input.now,
  })
}

export async function checkSendReplyRateLimit(input: {
  userId: string
  submissionId: string
  now?: Date
}): Promise<RateLimitResult> {
  const userResult = await checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `send-reply-user:${input.userId}`,
    minuteLimit: DEFAULT_SEND_REPLY_PER_MINUTE_PER_USER,
    hourLimit: null,
    now: input.now,
  })
  if (!userResult.allowed) return userResult
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `send-reply-submission:${input.submissionId}`,
    minuteLimit: DEFAULT_SEND_REPLY_PER_MINUTE_PER_SUBMISSION,
    hourLimit: null,
    now: input.now,
  })
}

// ─── Trusted-proxy client IP (SEC-204) ──────────────────────────────────

// `X-Forwarded-For` is client-controlled: trusting it unconditionally
// lets an attacker rotate the header and reset their per-IP bucket on
// every request. Only trust it when the direct peer is a configured
// trusted proxy. `TRUSTED_PROXY_IPS` is a comma-separated list of
// proxy IPs, CIDR ranges, or the token `cloudflare` (trust
// `cf-connecting-ip` only when the request carries `cf-ray`, i.e. it
// actually passed through Cloudflare, which overwrites that header).
// Unset/empty = no proxy is trusted: the peer IP (NextRequest.ip) is
// the client, and with no peer IP the caller buckets as "unknown"
// (all unidentified callers share one bucket — fail-closed for
// floods, never fail-open to a spoofable header). Operators behind
// Vercel/Cloudflare set this to the platform's egress ranges; until
// then the limiter keys on the peer IP, which Vercel/Next populate
// from the real connection.
//
// Pure over (headers, peerIp) so it is unit-testable without Next.js.
export function parseTrustedProxyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function ipToBytes(ip: string): number[] | null {
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) normalises to the IPv4 form.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  const dotted = mapped ? mapped[1] : ip
  if (/^\d+\.\d+\.\d+\.\d+$/.test(dotted)) {
    const parts = dotted.split(".").map(Number)
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null
    }
    return parts
  }
  if (ip.includes(":")) {
    // Expand :: then parse the eight 16-bit groups.
    const halves = ip.split("::")
    if (halves.length > 2) return null
    const left = halves[0] ? halves[0].split(":") : []
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
    if (left.length + right.length > 7) return null
    const missing = 8 - left.length - right.length
    const groups = [...left, ...Array(missing).fill("0"), ...right]
    const bytes: number[] = []
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      const value = parseInt(group, 16)
      bytes.push((value >> 8) & 0xff, value & 0xff)
    }
    return bytes.length === 16 ? bytes : null
  }
  return null
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/")
  if (slash === -1) {
    const a = ipToBytes(ip)
    const b = ipToBytes(cidr)
    return (
      a !== null &&
      b !== null &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    )
  }
  const base = cidr.slice(0, slash)
  const prefix = Number(cidr.slice(slash + 1))
  const a = ipToBytes(ip)
  const b = ipToBytes(base)
  if (a === null || b === null || a.length !== b.length) return false
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.length * 8) {
    return false
  }
  const fullBytes = Math.floor(prefix / 8)
  const restBits = prefix % 8
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false
  }
  if (restBits > 0) {
    const mask = (0xff << (8 - restBits)) & 0xff
    if ((a[fullBytes] & mask) !== (b[fullBytes] & mask)) return false
  }
  return true
}

export function resolveClientIp(
  headers: Pick<Headers, "get">,
  peerIp?: string | null
): string | null {
  const trusted = parseTrustedProxyList(process.env.TRUSTED_PROXY_IPS)
  if (trusted.includes("cloudflare") && headers.get("cf-ray")) {
    const connecting = headers.get("cf-connecting-ip")
    if (connecting) return connecting.split(",")[0].trim() || null
  }
  const peer = peerIp?.trim() || null
  if (peer && trusted.some((entry) => ipMatchesCidr(peer, entry))) {
    const forwarded = headers.get("x-forwarded-for")
    if (forwarded) return forwarded.split(",")[0].trim() || peer
    return peer
  }
  // No trusted proxy: the peer IP is the client. Never fall back to
  // x-forwarded-for / x-real-ip — both are client-supplied.
  return peer
}
