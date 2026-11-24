// Auth rate limiting at the route layer (Phase 16, Wave 1:
// SEC-008 / SEC-203 / EML-003). The Better Auth handler is mocked —
// these tests pin the route's own gating decisions, with the REAL
// @sendcms/security limiter running against the same in-memory
// bucket fake as tests/admin-rate-limit.test.ts. No test hits the
// real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

type StoredBucket = {
  scope: string
  subject: string
  minuteWindowStart: Date
  minuteCount: number
  hourWindowStart: Date
  hourCount: number
}

const { store, mockDb, mockQueryRaw, mockAuthPost, mockAuthGet } = vi.hoisted(
  () => {
    const store = { buckets: new Map<string, StoredBucket>() }
    const mockQueryRaw = vi.fn(async (first: unknown, ...rest: unknown[]) => {
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
      // Mirrors the real upsert's sliding-window minute (SEC-205).
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
    const mockAuthPost = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    const mockAuthGet = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    return {
      store,
      mockDb: { $queryRaw: mockQueryRaw },
      mockQueryRaw,
      mockAuthPost,
      mockAuthGet,
    }
  }
)

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

vi.mock("@/lib/auth", () => ({
  betterAuth: {
    options: {
      trustedOrigins: ["http://localhost:3002"],
      baseURL: "http://localhost:3001",
    },
  },
  auth: vi.fn(),
}))

vi.mock("@sendcms/auth", () => ({
  toNextJsHandler: () => ({ GET: mockAuthGet, POST: mockAuthPost }),
}))

import { GET, POST } from "../apps/api/app/api/auth/[...all]/route"

const API = "http://localhost:3001"

function authPost(path: string, body: unknown): NextRequest {
  return new NextRequest(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: API,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  store.buckets.clear()
  mockQueryRaw.mockClear()
  mockAuthPost.mockClear()
  mockAuthGet.mockClear()
})

describe("POST /api/auth/* rate limiting (SEC-008 / SEC-203 / EML-003)", () => {
  it("429s the 11th sign-up for one email", async () => {
    const body = {
      email: "w1-signup@example.com",
      name: "Probe",
      password: "ProbePass123!",
    }
    for (let i = 0; i < 10; i++) {
      const res = await POST(authPost("/api/auth/sign-up/email", body))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/sign-up/email", body))
    expect(denied.status).toBe(429)
    expect(denied.headers.get("Retry-After")).toBeTruthy()
    expect(mockAuthPost).toHaveBeenCalledTimes(10)
  })

  it("429s the 11th forgot-password for one email", async () => {
    const body = {
      email: "w1-reset@example.com",
      redirectTo: "/reset-password",
    }
    for (let i = 0; i < 10; i++) {
      const res = await POST(authPost("/api/auth/forget-password", body))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/forget-password", body))
    expect(denied.status).toBe(429)
    expect(mockAuthPost).toHaveBeenCalledTimes(10)
  })

  it("429s the 21st reset-password from one IP (no email in body)", async () => {
    const body = { newPassword: "ProbePass123!", token: "tok" }
    for (let i = 0; i < 20; i++) {
      const res = await POST(authPost("/api/auth/reset-password", body))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/reset-password", body))
    expect(denied.status).toBe(429)
  })

  it("429s the 11th send-verification-email, without touching the reset budget", async () => {
    const email = "w1-verify@example.com"
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        authPost("/api/auth/forget-password", {
          email,
          redirectTo: "/reset-password",
        })
      )
      expect(res.status).toBe(200)
    }
    // Reset budget is spent, but verification mail has its own kind.
    const verify = await POST(
      authPost("/api/auth/send-verification-email", { email })
    )
    expect(verify.status).toBe(200)
    for (let i = 0; i < 9; i++) {
      const res = await POST(
        authPost("/api/auth/send-verification-email", { email })
      )
      expect(res.status).toBe(200)
    }
    const denied = await POST(
      authPost("/api/auth/send-verification-email", { email })
    )
    expect(denied.status).toBe(429)
  })

  it("429s the 21st OAuth initiation from one IP", async () => {
    const body = { provider: "google", callbackURL: "/dashboard" }
    for (let i = 0; i < 20; i++) {
      const res = await POST(authPost("/api/auth/sign-in/social", body))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/sign-in/social", body))
    expect(denied.status).toBe(429)
  })

  it("still 429s the 11th sign-in for one email", async () => {
    const body = { email: "w1-signin@example.com", password: "ProbePass123!" }
    for (let i = 0; i < 10; i++) {
      const res = await POST(authPost("/api/auth/sign-in/email", body))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/sign-in/email", body))
    expect(denied.status).toBe(429)
  })

  it("does not rate-limit GETs", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await GET(
        new NextRequest(`${API}/api/auth/session`, { headers: { Origin: API } })
      )
      expect(res.status).toBe(200)
    }
    expect(mockAuthGet).toHaveBeenCalledTimes(5)
  })

  it("two unknown-IP sign-in bursts do not share one bucket (SRC-327)", async () => {
    // These requests carry no resolvable IP (NextRequest has no peer
    // IP), so the old shared `ip:unknown` bucket would 429 the second
    // burst after the first burst spent it. With the fix, an
    // unknown-IP caller is keyed by email instead: burst A exhausts
    // its own email budget, burst B (a different email) still gets
    // its first requests through.
    const burstA = {
      email: "w1-burst-a@example.com",
      password: "ProbePass123!",
    }
    for (let i = 0; i < 25; i++) {
      await POST(authPost("/api/auth/sign-in/email", burstA))
    }
    const burstB = {
      email: "w1-burst-b@example.com",
      password: "ProbePass123!",
    }
    for (let i = 0; i < 10; i++) {
      const res = await POST(authPost("/api/auth/sign-in/email", burstB))
      expect(res.status).toBe(200)
    }
    const denied = await POST(authPost("/api/auth/sign-in/email", burstB))
    expect(denied.status).toBe(429)
  })
})
