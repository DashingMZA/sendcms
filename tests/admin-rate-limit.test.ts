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
  checkAuthEmailRateLimit,
  checkAuthSignInRateLimit,
  checkAuthSignUpRateLimit,
  checkRateLimit,
  checkSendReplyRateLimit,
  checkTestEmailRateLimit,
  DEFAULT_RATE_LIMIT_CONFIG,
  ipMatchesCidr,
  parseRateLimitConfig,
  readRateLimitConfig,
  resetRateLimitConfigCache,
  resolveClientIp,
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
    const [scope, subject, minuteStart, hourStart, carryWeight] = values as [
      string,
      string,
      Date,
      Date,
      number,
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
    // Mirrors the real upsert's sliding-window minute (SEC-205): same
    // window → +1; roll to the adjacent minute → 1 + the decayed
    // carry of the previous minute's count; a roll after a gap of
    // two minutes or more → 1.
    let minuteCount: number
    if (existing.minuteWindowStart.getTime() === minuteStart.getTime()) {
      minuteCount = existing.minuteCount + 1
    } else if (
      minuteStart.getTime() - existing.minuteWindowStart.getTime() ===
      60_000
    ) {
      minuteCount = 1 + Math.floor(existing.minuteCount * (carryWeight ?? 0))
    } else {
      minuteCount = 1
    }
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

describe("checkRateLimit sliding-window minute (SEC-205)", () => {
  it("denies a burst split across a minute boundary", async () => {
    // 10 requests at :59 of one minute (limit 10), then 2 more at
    // :01 of the next: the previous minute is still almost fully
    // inside a rolling 60-second window, so the carried count plus
    // the new requests exceeds the limit.
    const before = new Date("2026-11-22T06:00:59.000Z")
    const after = new Date("2026-11-22T06:01:01.000Z")
    const args = {
      scope: RateLimitScope.ADMIN_API,
      subject: "user:boundary",
      minuteLimit: 10,
      hourLimit: 100,
      now: before,
    }
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimit(args)).allowed).toBe(true)
    }
    expect((await checkRateLimit({ ...args, now: after })).allowed).toBe(true)
    const denied = await checkRateLimit({ ...args, now: after })
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it("carries nothing after a gap of two minutes or more", async () => {
    const args = {
      scope: RateLimitScope.ADMIN_API,
      subject: "user:gap",
      minuteLimit: 10,
      hourLimit: 100,
      now: T,
    }
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimit(args)).allowed).toBe(true)
    }
    const later = new Date(T.getTime() + 3 * 60_000)
    const result = await checkRateLimit({ ...args, now: later })
    expect(result.allowed).toBe(true)
    expect(result.minuteCount).toBe(1)
  })

  it("decays the carry late in the new minute", async () => {
    // 10 requests at :59, then one request at :59 of the next
    // minute: the previous minute is ~2 seconds inside the rolling
    // window, so the carry is ~0 and the request is allowed.
    const before = new Date("2026-11-22T06:00:59.000Z")
    const late = new Date("2026-11-22T06:01:59.000Z")
    const args = {
      scope: RateLimitScope.ADMIN_API,
      subject: "user:decay",
      minuteLimit: 10,
      hourLimit: 100,
      now: before,
    }
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimit(args)).allowed).toBe(true)
    }
    const result = await checkRateLimit({ ...args, now: late })
    expect(result.allowed).toBe(true)
    expect(result.minuteCount).toBe(1)
  })
})

describe("checkAuthSignUpRateLimit (SEC-008 / SEC-203)", () => {
  it("checks signup-namespaced IP then email buckets", async () => {
    const result = await checkAuthSignUpRateLimit({
      ip: "203.0.113.7",
      email: "new@example.com",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(subjectsSeen()).toEqual([
      "signup-ip:203.0.113.7",
      "signup-email:new@example.com",
    ])
  })

  it("does not consume the sign-in buckets", async () => {
    await checkAuthSignUpRateLimit({
      ip: "203.0.113.7",
      email: "new@example.com",
      now: T,
    })
    expect(subjectsSeen()).not.toContain("ip:203.0.113.7")
    expect(subjectsSeen()).not.toContain("email:new@example.com")
  })

  it("denies after 10 sign-ups for one email from fresh IPs", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await checkAuthSignUpRateLimit({
        ip: `203.0.113.${i + 1}`,
        email: "victim@example.com",
        now: T,
      })
      expect(result.allowed).toBe(true)
    }
    const denied = await checkAuthSignUpRateLimit({
      ip: "203.0.113.99",
      email: "victim@example.com",
      now: T,
    })
    expect(denied.allowed).toBe(false)
  })
})

describe("checkAuthEmailRateLimit (SEC-008 / EML-003)", () => {
  it("namespaces buckets per kind", async () => {
    await checkAuthEmailRateLimit({
      ip: "203.0.113.7",
      email: "a@example.com",
      kind: "reset",
      now: T,
    })
    await checkAuthEmailRateLimit({
      ip: "203.0.113.7",
      email: "a@example.com",
      kind: "verify",
      now: T,
    })
    expect(subjectsSeen()).toEqual([
      "reset-ip:203.0.113.7",
      "reset-email:a@example.com",
      "verify-ip:203.0.113.7",
      "verify-email:a@example.com",
    ])
  })

  it("denies the 11th reset for one email, other kinds unaffected", async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await checkAuthEmailRateLimit({
            ip: `203.0.113.${i + 1}`,
            email: "victim@example.com",
            kind: "reset",
            now: T,
          })
        ).allowed
      ).toBe(true)
    }
    const denied = await checkAuthEmailRateLimit({
      ip: "203.0.113.99",
      email: "victim@example.com",
      kind: "reset",
      now: T,
    })
    expect(denied.allowed).toBe(false)
    const otherKind = await checkAuthEmailRateLimit({
      ip: "203.0.113.99",
      email: "victim@example.com",
      kind: "verify",
      now: T,
    })
    expect(otherKind.allowed).toBe(true)
  })

  it("checks only the IP bucket when no email is supplied", async () => {
    const result = await checkAuthEmailRateLimit({
      ip: "203.0.113.7",
      kind: "social",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(mockQueryRaw).toHaveBeenCalledTimes(1)
    expect(subjectsSeen()).toEqual(["social-ip:203.0.113.7"])
  })
})

describe("checkTestEmailRateLimit / checkSendReplyRateLimit (EML-003)", () => {
  it("keys test-email per user then per form", async () => {
    const result = await checkTestEmailRateLimit({
      userId: "u1",
      formId: "f1",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(subjectsSeen()).toEqual(["test-email-user:u1", "test-email-form:f1"])
  })

  it("denies the 11th test-email for one user", async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await checkTestEmailRateLimit({
            userId: "u1",
            formId: `f${i}`,
            now: T,
          })
        ).allowed
      ).toBe(true)
    }
    const denied = await checkTestEmailRateLimit({
      userId: "u1",
      formId: "f99",
      now: T,
    })
    expect(denied.allowed).toBe(false)
  })

  it("keys send-reply per user then per submission", async () => {
    const result = await checkSendReplyRateLimit({
      userId: "u1",
      submissionId: "s1",
      now: T,
    })
    expect(result.allowed).toBe(true)
    expect(subjectsSeen()).toEqual([
      "send-reply-user:u1",
      "send-reply-submission:s1",
    ])
  })

  it("denies the 6th reply to one submission", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await checkSendReplyRateLimit({
            userId: `u${i}`,
            submissionId: "s1",
            now: T,
          })
        ).allowed
      ).toBe(true)
    }
    const denied = await checkSendReplyRateLimit({
      userId: "u99",
      submissionId: "s1",
      now: T,
    })
    expect(denied.allowed).toBe(false)
  })
})

describe("resolveClientIp trusted proxy (SEC-204)", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries)

  beforeEach(() => {
    delete process.env.TRUSTED_PROXY_IPS
  })

  it("ignores a spoofed X-Forwarded-For with no trusted proxy", () => {
    const ip = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" }),
      "192.0.2.44"
    )
    expect(ip).toBe("192.0.2.44")
  })

  it("returns null with no peer IP and no trusted proxy", () => {
    const ip = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7" }),
      null
    )
    expect(ip).toBeNull()
  })

  it("rotating spoofed XFF values all resolve to the same peer IP", () => {
    const ips = ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((spoof) =>
      resolveClientIp(headers({ "x-forwarded-for": spoof }), "192.0.2.44")
    )
    expect(ips).toEqual(["192.0.2.44", "192.0.2.44", "192.0.2.44"])
  })

  it("trusts XFF when the peer is a listed proxy IP", () => {
    process.env.TRUSTED_PROXY_IPS = "192.0.2.44"
    const ip = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7, 192.0.2.44" }),
      "192.0.2.44"
    )
    expect(ip).toBe("203.0.113.7")
  })

  it("trusts XFF when the peer is inside a listed CIDR", () => {
    process.env.TRUSTED_PROXY_IPS = "192.0.2.0/24"
    const ip = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7" }),
      "192.0.2.200"
    )
    expect(ip).toBe("203.0.113.7")
  })

  it("does not trust XFF when the peer is outside the listed CIDR", () => {
    process.env.TRUSTED_PROXY_IPS = "192.0.2.0/24"
    const ip = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7" }),
      "192.0.3.200"
    )
    expect(ip).toBe("192.0.3.200")
  })

  it("trusts cf-connecting-ip only with cf-ray and the cloudflare token", () => {
    process.env.TRUSTED_PROXY_IPS = "cloudflare"
    const viaCf = resolveClientIp(
      headers({
        "cf-ray": "abc123",
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.9",
      }),
      "172.64.0.1"
    )
    expect(viaCf).toBe("203.0.113.7")
    const noRay = resolveClientIp(
      headers({ "cf-connecting-ip": "203.0.113.7" }),
      "172.64.0.1"
    )
    expect(noRay).toBe("172.64.0.1")
  })
})

describe("ipMatchesCidr", () => {
  it("matches exact IPs and IPv4 CIDRs", () => {
    expect(ipMatchesCidr("192.0.2.44", "192.0.2.44")).toBe(true)
    expect(ipMatchesCidr("192.0.2.44", "192.0.2.45")).toBe(false)
    expect(ipMatchesCidr("192.0.2.200", "192.0.2.0/24")).toBe(true)
    expect(ipMatchesCidr("192.0.3.200", "192.0.2.0/24")).toBe(false)
    expect(ipMatchesCidr("10.0.0.1", "10.0.0.0/8")).toBe(true)
  })

  it("matches IPv6 CIDRs and normalises IPv4-mapped IPv6", () => {
    expect(ipMatchesCidr("2001:db8::1", "2001:db8::/32")).toBe(true)
    expect(ipMatchesCidr("2001:db9::1", "2001:db8::/32")).toBe(false)
    expect(ipMatchesCidr("::ffff:192.0.2.44", "192.0.2.44")).toBe(true)
  })

  it("rejects malformed input", () => {
    expect(ipMatchesCidr("not-an-ip", "192.0.2.0/24")).toBe(false)
    expect(ipMatchesCidr("192.0.2.1", "192.0.2.0/33")).toBe(false)
  })
})
