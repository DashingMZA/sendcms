// Admin-API + auth sign-in rate limiting (Admin Control Plane,
// Phase 9) with a mocked Prisma client. The real @sendcms/security
// limiter runs — only the database is stubbed, with an in-memory
// fake that mirrors the single INSERT ... ON CONFLICT ... RETURNING
// statement's semantics (insert on first use, else advance the
// counters, rolling a window over when its start has moved). No test
// hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RateLimitScope } from "@sendcms/database"
import {
  checkAdminApiRateLimit,
  checkAuthSignInRateLimit,
  checkRateLimit,
  DEFAULT_RATE_LIMIT_CONFIG,
  parseRateLimitConfig,
  readRateLimitConfig,
  resetRateLimitConfigCache,
} from "@sendcms/security"

type StoredBucket = {
  scope: string
  subject: string
  minuteWindowStart: Date
  minuteCount: number
  hourWindowStart: Date
  hourCount: number
}

const { store, mockDb, mockQueryRaw } = vi.hoisted(() => {
  const store = { buckets: new Map<string, StoredBucket>() }
  const mockQueryRaw = vi.fn(async (first: unknown, ...rest: unknown[]) => {
    // The service passes one Prisma.sql`` value (an object with a
    // .values array); a raw template call would arrive as
    // (strings, ...values). Accept both.
    const values =
      first !== null &&
      typeof first === "object" &&
      "values" in (first as Record<string, unknown>) &&
      Array.isArray((first as { values: unknown[] }).values)
        ? (first as { values: unknown[] }).values
        : rest
    const [scope, subject, minuteStart, hourStart] = values as [
      string,
      string,
      Date,
      Date,
    ]
    const key = `${scope}|${subject}`
    const existing = store.buckets.get(key)
    if (!existing) {
      const row: StoredBucket = {
        scope,
        subject,
        minuteWindowStart: minuteStart,
        minuteCount: 1,
        hourWindowStart: hourStart,
        hourCount: 1,
      }
      store.buckets.set(key, row)
      return [
        {
          minuteCount: 1,
          hourCount: 1,
          minuteWindowStart: minuteStart,
          hourWindowStart: hourStart,
        },
      ]
    }
    const minuteCount =
      existing.minuteWindowStart.getTime() === minuteStart.getTime()
        ? existing.minuteCount + 1
        : 1
    const hourCount =
      existing.hourWindowStart.getTime() === hourStart.getTime()
        ? existing.hourCount + 1
        : 1
    existing.minuteWindowStart = minuteStart
    existing.minuteCount = minuteCount
    existing.hourWindowStart = hourStart
    existing.hourCount = hourCount
    return [
      {
        minuteCount,
        hourCount,
        minuteWindowStart: minuteStart,
        hourWindowStart: hourStart,
      },
    ]
  })
  return { store, mockDb: { $queryRaw: mockQueryRaw }, mockQueryRaw }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

// Subjects the fake saw, in call order (the Sql object's .values[1]).
function subjectsSeen(): string[] {
  return mockQueryRaw.mock.calls.map((call) => {
    const first = call[0] as { values?: unknown[] }
    const values = Array.isArray(first?.values) ? first.values : call.slice(1)
    return String(values[1])
  })
}

const T = new Date("2026-11-22T06:00:30.000Z")
const T_PLUS_61S = new Date(T.getTime() + 61_000)
const T_PLUS_61MIN = new Date(T.getTime() + 61 * 60_000)

beforeEach(() => {
  store.buckets.clear()
  mockQueryRaw.mockClear()
  resetRateLimitConfigCache()
})

describe("checkRateLimit (generic fixed windows)", () => {
  it("counts the first call as 1 in both windows and allows it", async () => {
    const result = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 2,
      hourLimit: 5,
      now: T,
    })
    expect(result).toEqual({
      allowed: true,
      minuteCount: 1,
      hourCount: 1,
    })
  })

  it("rolls the minute window over (hour count keeps growing)", async () => {
    const first = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 10,
      hourLimit: 10,
      now: T,
    })
    expect(first.minuteCount).toBe(1)
    const second = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 10,
      hourLimit: 10,
      now: T_PLUS_61S,
    })
    expect(second).toEqual({
      allowed: true,
      minuteCount: 1,
      hourCount: 2,
    })
  })

  it("rolls the hour window over", async () => {
    await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 10,
      hourLimit: 10,
      now: T,
    })
    const second = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 10,
      hourLimit: 10,
      now: T_PLUS_61MIN,
    })
    expect(second).toEqual({
      allowed: true,
      minuteCount: 1,
      hourCount: 1,
    })
  })

  it("denies over the minute limit with a Retry-After inside the minute", async () => {
    await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 2,
      hourLimit: 100,
      now: T,
    })
    await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 2,
      hourLimit: 100,
      now: T,
    })
    const denied = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 2,
      hourLimit: 100,
      now: T,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60)
    // Still denied while the window lasts (the count keeps growing).
    const again = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 2,
      hourLimit: 100,
      now: T,
    })
    expect(again.allowed).toBe(false)
  })

  it("denies over the hour limit with a Retry-After inside the hour", async () => {
    const args = {
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 100,
      hourLimit: 2,
      now: T,
    }
    await checkRateLimit(args)
    await checkRateLimit(args)
    const denied = await checkRateLimit(args)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(3600)
  })

  it("fails open when the database throws", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("database is down"))
    const result = await checkRateLimit({
      scope: RateLimitScope.ADMIN_API,
      subject: "user:u1",
      minuteLimit: 1,
      hourLimit: 1,
      now: T,
    })
    expect(result).toEqual({
      allowed: true,
      minuteCount: 0,
      hourCount: 0,
    })
  })
})

describe("checkAdminApiRateLimit (per-user keying)", () => {
  it("keys by user id — different users get different buckets", async () => {
    const first = await checkAdminApiRateLimit({ userId: "u1", now: T })
    expect(first.minuteCount).toBe(1)
    const second = await checkAdminApiRateLimit({ userId: "u1", now: T })
    expect(second.minuteCount).toBe(2)
    const other = await checkAdminApiRateLimit({ userId: "u2", now: T })
    expect(other.minuteCount).toBe(1)
    expect(subjectsSeen()).toEqual(["user:u1", "user:u1", "user:u2"])
  })

  it("falls back to the client IP without a user", async () => {
    const result = await checkAdminApiRateLimit({
      ip: "203.0.113.7",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(subjectsSeen()).toEqual(["ip:203.0.113.7"])
  })

  it("uses the limits from config/config.json", async () => {
    expect(readRateLimitConfig()).toEqual({
      adminApi: { perMinute: 600, perHour: 10000 },
      authSignIn: { perMinutePerIp: 20, perMinutePerEmail: 10 },
    })
  })
})

describe("parseRateLimitConfig", () => {
  it("returns the defaults for missing or invalid input", () => {
    expect(parseRateLimitConfig(undefined)).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
    expect(parseRateLimitConfig(null)).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
    expect(parseRateLimitConfig("nope")).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
    expect(parseRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMIT_CONFIG)
  })

  it("falls back per field, keeping the valid ones", () => {
    expect(
      parseRateLimitConfig({
        rateLimits: {
          adminApi: { perMinute: 5, perHour: 0 },
          authSignIn: { perMinutePerIp: -1, perMinutePerEmail: 2.5 },
        },
      })
    ).toEqual({
      adminApi: { perMinute: 5, perHour: 10000 },
      authSignIn: { perMinutePerIp: 20, perMinutePerEmail: 10 },
    })
  })

  it("accepts a complete valid config", () => {
    expect(
      parseRateLimitConfig({
        rateLimits: {
          adminApi: { perMinute: 5, perHour: 50 },
          authSignIn: { perMinutePerIp: 3, perMinutePerEmail: 2 },
        },
      })
    ).toEqual({
      adminApi: { perMinute: 5, perHour: 50 },
      authSignIn: { perMinutePerIp: 3, perMinutePerEmail: 2 },
    })
  })
})

describe("checkAuthSignInRateLimit (per-IP + per-email)", () => {
  it("checks the IP bucket then the email bucket", async () => {
    const result = await checkAuthSignInRateLimit({
      ip: "203.0.113.7",
      email: "alice@example.com",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(mockQueryRaw).toHaveBeenCalledTimes(2)
    expect(subjectsSeen()).toEqual([
      "ip:203.0.113.7",
      "email:alice@example.com",
    ])
  })

  it("lowercases and trims the email before keying", async () => {
    await checkAuthSignInRateLimit({
      ip: "203.0.113.7",
      email: "  Alice@Example.COM ",
      now: T,
    })
    expect(subjectsSeen()).toEqual([
      "ip:203.0.113.7",
      "email:alice@example.com",
    ])
  })

  it("denies when the email bucket is over, even from a fresh IP", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await checkAuthSignInRateLimit({
        ip: `203.0.113.${i + 1}`,
        email: "alice@example.com",
        now: T,
      })
      expect(result.allowed).toBe(true)
    }
    const denied = await checkAuthSignInRateLimit({
      ip: "203.0.113.99",
      email: "alice@example.com",
      now: T,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it("denies on the IP bucket without touching the email bucket", async () => {
    for (let i = 0; i < 20; i++) {
      const result = await checkAuthSignInRateLimit({
        ip: "203.0.113.7",
        email: `user${i}@example.com`,
        now: T,
      })
      expect(result.allowed).toBe(true)
    }
    const before = mockQueryRaw.mock.calls.length
    const denied = await checkAuthSignInRateLimit({
      ip: "203.0.113.7",
      email: "someone-else@example.com",
      now: T,
    })
    expect(denied.allowed).toBe(false)
    // Only the IP check ran — the email bucket was never consulted.
    expect(mockQueryRaw.mock.calls.length).toBe(before + 1)
    expect(subjectsSeen().at(-1)).toBe("ip:203.0.113.7")
  })

  it("checks only the IP bucket when no email is supplied", async () => {
    const result = await checkAuthSignInRateLimit({
      ip: "203.0.113.7",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(mockQueryRaw).toHaveBeenCalledTimes(1)
    expect(subjectsSeen()).toEqual(["ip:203.0.113.7"])
  })

  it("fails open when the database throws", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("database is down"))
    const result = await checkAuthSignInRateLimit({
      ip: "203.0.113.7",
      email: "alice@example.com",
      now: T,
    })
    expect(result.allowed).toBe(true)
  })
})
