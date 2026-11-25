// Phase 16, Wave 6 — Stream A (customer AI usage).
//
// AIM-014: getMyAiUsage — the caller's own AI billing mode, remaining
// AI allowance for today, today's BYOK/platform calls, and
// provider-reported cost. Owner-scoped by construction; 404 for an
// unknown user; another user's rows are never in the result.
//
// AI-settings service with a mocked Prisma client and a mocked plans
// checkLimit. No test hits the real DB or a real provider.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCheckLimit = vi.hoisted(() => vi.fn())

type GroupRow = {
  billingMode: string
  status: string
  _count: { _all: number }
  _sum: {
    tokensIn: number | null
    tokensOut: number | null
    costMicros: number | null
  }
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    users: new Set<string>(["user-1"]),
    settings: new Map<string, string>([["user-1", "BYOK"]]),
    groups: [] as GroupRow[],
    totalCostMicros: 0,
  }
  const mockDb = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.users.has(where.id) ? { id: where.id } : null
      ),
    },
    userAiSettings: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const billingMode = store.settings.get(where.userId)
        return billingMode ? { billingMode } : null
      }),
    },
    aiUsageRecord: {
      groupBy: vi.fn(async () => store.groups),
      aggregate: vi.fn(async () => ({
        _sum: { costMicros: store.totalCostMicros },
      })),
    },
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, checkLimit: mockCheckLimit }
})

import { getMyAiUsage } from "@sendcms/ai-settings"
import { ApiError } from "@sendcms/api-client"

beforeEach(() => {
  vi.clearAllMocks()
  store.users = new Set(["user-1"])
  store.settings = new Map([["user-1", "BYOK"]])
  store.groups = [
    {
      billingMode: "BYOK",
      status: "SUCCESS",
      _count: { _all: 3 },
      _sum: { tokensIn: 100, tokensOut: 50, costMicros: 1200 },
    },
    {
      billingMode: "PLATFORM",
      status: "SUCCESS",
      _count: { _all: 2 },
      _sum: { tokensIn: 40, tokensOut: 20, costMicros: 500 },
    },
    {
      billingMode: "BYOK",
      status: "FAILED",
      _count: { _all: 1 },
      _sum: { tokensIn: 0, tokensOut: 0, costMicros: 0 },
    },
  ]
  store.totalCostMicros = 1700
  mockCheckLimit.mockResolvedValue({
    allowed: true,
    limit: 100,
    used: 4,
    remaining: 96,
  })
})

describe("getMyAiUsage (AIM-014)", () => {
  it("returns the caller's mode, allowance, and today's BYOK/platform split", async () => {
    const usage = await getMyAiUsage("user-1")
    expect(usage.billingMode).toBe("BYOK")
    expect(usage.allowance).toEqual({
      allowed: true,
      limit: 100,
      used: 4,
      remaining: 96,
    })
    expect(usage.today.byok.calls).toBe(4)
    expect(usage.today.byok.success).toBe(3)
    expect(usage.today.byok.failed).toBe(1)
    expect(usage.today.byok.costMicros).toBe(1200)
    expect(usage.today.platform.calls).toBe(2)
    expect(usage.today.platform.costMicros).toBe(500)
    expect(usage.today.total.calls).toBe(6)
    expect(usage.today.total.costMicros).toBe(1700)
    expect(usage.totalCostMicros).toBe(1700)
    expect(mockCheckLimit).toHaveBeenCalledWith("user-1", "AI_REQUESTS")
  })

  it("defaults to PLATFORM mode when the user has no settings row", async () => {
    store.settings.delete("user-1")
    const usage = await getMyAiUsage("user-1")
    expect(usage.billingMode).toBe("PLATFORM")
  })

  it("returns zeroed totals when the user made no AI calls today", async () => {
    store.groups = []
    store.totalCostMicros = 0
    const usage = await getMyAiUsage("user-1")
    expect(usage.today.total.calls).toBe(0)
    expect(usage.today.total.costMicros).toBe(0)
    expect(usage.totalCostMicros).toBe(0)
  })

  it("404s for an unknown user", async () => {
    try {
      await getMyAiUsage("user-nope")
      throw new Error("expected 404")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(404)
    }
    expect(mockCheckLimit).not.toHaveBeenCalled()
  })
})
