import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
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

let rateLimitConfigCache: RateLimitConfig | null = null

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

// Reads config/config.json once per process (same pattern as the plans
// module's readPlatformConfig). A missing file, bad JSON, or missing
// key all mean "use the defaults" — the limiter must never fail
// because its config is unreadable; the fail-open rule below covers
// the rest.
export function readRateLimitConfig(): RateLimitConfig {
  if (rateLimitConfigCache) return rateLimitConfigCache
  let config = DEFAULT_RATE_LIMIT_CONFIG
  try {
    const root = findWorkspaceRoot(process.cwd())
    if (root) {
      const raw = readFileSync(join(root, "config", "config.json"), "utf8")
      config = parseRateLimitConfig(JSON.parse(raw) as unknown)
    }
  } catch {
    config = DEFAULT_RATE_LIMIT_CONFIG
  }
  rateLimitConfigCache = config
  return rateLimitConfigCache
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
async function incrementBucket(
  scope: RateLimitScope,
  subject: string,
  minuteStart: Date,
  hourStart: Date
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

// Generic fixed-window check: minute + hour buckets for one
// (scope, subject) pair. `hourLimit` null skips the hour window
// (auth sign-in is minute-only). FAIL-OPEN: any limiter error (DB
// down, bad SQL, unexpected row) is logged and the request is
// allowed — a broken limiter must never lock the owner out of their
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
  try {
    const row = await incrementBucket(
      input.scope,
      input.subject,
      minuteStart,
      hourStart
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
// anonymous hits from ever reaching the per-user counters).
export async function checkAdminApiRateLimit(input: {
  userId?: string | null
  ip?: string | null
  now?: Date
}): Promise<RateLimitResult> {
  const config = readRateLimitConfig()
  const subject = input.userId
    ? `user:${input.userId}`
    : `ip:${input.ip ?? "unknown"}`
  return checkRateLimit({
    scope: RateLimitScope.ADMIN_API,
    subject,
    minuteLimit: config.adminApi.perMinute,
    hourLimit: config.adminApi.perHour,
    now: input.now,
  })
}

// Auth sign-in: TWO buckets, both must pass — per-IP (one address
// hammering many accounts) and per-email (many addresses hammering
// one account). The email bucket is only checked when an email was
// supplied (a body that fails to parse still gets the IP bucket).
// Returns the first denial, so the caller reports one Retry-After.
export async function checkAuthSignInRateLimit(input: {
  ip?: string | null
  email?: string | null
  now?: Date
}): Promise<RateLimitResult> {
  const config = readRateLimitConfig()
  const ipResult = await checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `ip:${input.ip ?? "unknown"}`,
    minuteLimit: config.authSignIn.perMinutePerIp,
    hourLimit: null,
    now: input.now,
  })
  if (!ipResult.allowed) return ipResult
  const email = input.email?.trim().toLowerCase()
  if (!email) return ipResult
  return checkRateLimit({
    scope: RateLimitScope.AUTH,
    subject: `email:${email}`,
    minuteLimit: config.authSignIn.perMinutePerEmail,
    hourLimit: null,
    now: input.now,
  })
}
