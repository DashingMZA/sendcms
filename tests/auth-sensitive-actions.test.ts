// Sensitive auth actions at the route layer (Phase 16, Wave 2):
// SEC-007 step-up enforcement on change-password / change-email,
// SEC-012 session-token stripping from auth JSON bodies, SRC-122
// try/catch with CORS headers on the auth wrappers. The Better Auth
// handler is mocked — these tests pin the route's own gating
// decisions, with the REAL @sendcms/security step-up helpers running
// against an in-memory verification store. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

type StoredVerification = {
  id: string
  userId: string
  action: string | null
  verifiedAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

type StoredBucket = {
  scope: string
  subject: string
  minuteWindowStart: Date
  minuteCount: number
  hourWindowStart: Date
  hourCount: number
}

const { store, mockQueryRaw, mockAuthPost, mockAuthGet, mockAuth, mockDb } =
  vi.hoisted(() => {
    const store = {
      buckets: new Map<string, StoredBucket>(),
      verifications: [] as StoredVerification[],
    }
    // Same in-memory bucket fake as tests/auth-rate-limit.test.ts.
    const mockQueryRaw = vi.fn(async (first: unknown, ...rest: unknown[]) => {
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
    const mockAuthPost = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "session-token-that-must-not-leak",
            user: { id: "user-1" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    )
    const mockAuthGet = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    const mockAuth = vi.fn()
    const mockDb = {
      $queryRaw: mockQueryRaw,
      user: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
      stepUpVerification: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: {
              userId: string
              action: string | null
              consumedAt: null
              expiresAt: { gt: Date }
            }
          }) => {
            const rows = store.verifications
              .filter(
                (v) =>
                  v.userId === where.userId &&
                  (v.action ?? null) === (where.action ?? null) &&
                  v.consumedAt === null &&
                  v.expiresAt > where.expiresAt.gt
              )
              .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())
            return rows[0] ?? null
          }
        ),
        updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = store.verifications.find((v) => v.id === where.id)
          if (!row || row.consumedAt !== null) return { count: 0 }
          row.consumedAt = new Date()
          return { count: 1 }
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      auditLog: { findFirst: vi.fn(async () => null), create: vi.fn() },
    }
    return { store, mockQueryRaw, mockAuthPost, mockAuthGet, mockAuth, mockDb }
  })

const SESSION = {
  user: {
    id: "user-1",
    name: "User",
    email: "user@example.com",
    image: null,
    platformRole: "PLATFORM_USER",
    status: "ACTIVE",
    adminRole: null,
    emailVerified: true,
  },
  session: {
    id: "sess-1",
    userId: "user-1",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  },
}

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
  auth: mockAuth,
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
      Origin: "http://localhost:3002",
    },
    body: JSON.stringify(body),
  })
}

function mintProof(action: string): void {
  const now = new Date()
  store.verifications.push({
    id: `proof-${store.verifications.length + 1}`,
    userId: "user-1",
    action,
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
    consumedAt: null,
  })
}

beforeEach(() => {
  store.buckets.clear()
  store.verifications.length = 0
  mockQueryRaw.mockClear()
  mockAuthPost.mockClear()
  mockAuthGet.mockClear()
  mockAuth.mockResolvedValue(SESSION)
  mockDb.stepUpVerification.findFirst.mockClear()
  mockDb.stepUpVerification.updateMany.mockClear()
  mockDb.stepUpVerification.deleteMany.mockClear()
})

describe("POST /api/auth/* sensitive actions (SEC-007 / SEC-012 / SRC-122)", () => {
  it("change-password without a step-up proof → 403, handler never runs", async () => {
    const res = await POST(
      authPost("/api/auth/change-password", {
        currentPassword: "old-password",
        newPassword: "NewPassword123!",
      })
    )
    expect(res.status).toBe(403)
    expect(mockAuthPost).not.toHaveBeenCalled()
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Step-up verification required")
  })

  it("change-password with a proof → 200, token stripped, proof consumed", async () => {
    mintProof("change-password")
    const res = await POST(
      authPost("/api/auth/change-password", {
        currentPassword: "old-password",
        newPassword: "NewPassword123!",
      })
    )
    expect(res.status).toBe(200)
    expect(mockAuthPost).toHaveBeenCalledTimes(1)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty("token")
    expect(JSON.stringify(body)).not.toContain(
      "session-token-that-must-not-leak"
    )
    expect(mockDb.stepUpVerification.updateMany).toHaveBeenCalledTimes(1)
  })

  it("replaying a consumed proof → 403", async () => {
    mintProof("change-password")
    const first = await POST(
      authPost("/api/auth/change-password", {
        currentPassword: "old-password",
        newPassword: "NewPassword123!",
      })
    )
    expect(first.status).toBe(200)
    const replay = await POST(
      authPost("/api/auth/change-password", {
        currentPassword: "old-password",
        newPassword: "NewPassword123!",
      })
    )
    expect(replay.status).toBe(403)
    expect(mockAuthPost).toHaveBeenCalledTimes(1)
  })

  it("a proof for another action does not unlock change-password", async () => {
    mintProof("change-email")
    const res = await POST(
      authPost("/api/auth/change-password", {
        currentPassword: "old-password",
        newPassword: "NewPassword123!",
      })
    )
    expect(res.status).toBe(403)
    expect(mockAuthPost).not.toHaveBeenCalled()
  })

  it("change-email without a proof → 403", async () => {
    const res = await POST(
      authPost("/api/auth/change-email", { newEmail: "new@example.com" })
    )
    expect(res.status).toBe(403)
    expect(mockAuthPost).not.toHaveBeenCalled()
  })

  it("sign-in body carries no session token (SEC-012)", async () => {
    const res = await POST(
      authPost("/api/auth/sign-in/email", {
        email: "user@example.com",
        password: "Password123!",
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty("token")
    expect(JSON.stringify(body)).not.toContain(
      "session-token-that-must-not-leak"
    )
  })

  it("a throw inside the handler → 500 WITH CORS headers (SRC-122)", async () => {
    mockAuthPost.mockRejectedValueOnce(new Error("boom"))
    const res = await POST(
      authPost("/api/auth/sign-in/email", {
        email: "user@example.com",
        password: "Password123!",
      })
    )
    expect(res.status).toBe(500)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:3002"
    )
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Internal server error")
  })

  it("a throw inside GET → 500 WITH CORS headers (SRC-122)", async () => {
    mockAuthGet.mockRejectedValueOnce(new Error("boom"))
    const res = await GET(
      new NextRequest(`${API}/api/auth/session`, {
        headers: { Origin: "http://localhost:3002" },
      })
    )
    expect(res.status).toBe(500)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:3002"
    )
  })
})
