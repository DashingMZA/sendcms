// Customer AI rate limiting (AIM-002): the six customer AI POST
// routes are per-user limited (general budget, tighter budget on the
// two test routes that make live provider calls). The DB-backed
// counter is a faithful in-memory fake — it increments per subject
// and denies past the limit, like the real checkRateLimit — so these
// tests pin the route wiring (subjects, limits, 429 shape) and the
// burst behaviour, not the counter itself.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const rateBuckets = vi.hoisted(
  () =>
    new Map<
      string,
      {
        minuteCount: number
        minuteStart: number
        hourCount: number
        hourStart: number
      }
    >()
)
const countingFake = vi.hoisted(
  () =>
    async (input: {
      scope: string
      subject: string
      minuteLimit: number
      hourLimit?: number | null
    }) => {
      const now = Date.now()
      const minuteStart = Math.floor(now / 60_000) * 60_000
      const hourStart = Math.floor(now / 3_600_000) * 3_600_000
      const key = `${input.scope}:${input.subject}`
      let bucket = rateBuckets.get(key)
      if (!bucket || bucket.minuteStart !== minuteStart) {
        bucket = {
          minuteCount: 0,
          minuteStart,
          hourCount: bucket?.hourStart === hourStart ? bucket.hourCount : 0,
          hourStart,
        }
        rateBuckets.set(key, bucket)
      }
      // Like the real limiter: the call IS counted, then the count is
      // compared — a denied call still consumes its unit.
      bucket.minuteCount++
      bucket.hourCount++
      const allowed =
        bucket.minuteCount <= input.minuteLimit &&
        (input.hourLimit == null || bucket.hourCount <= input.hourLimit)
      return {
        allowed,
        retryAfterSeconds: allowed ? undefined : 60,
        minuteCount: bucket.minuteCount,
        hourCount: bucket.hourCount,
      }
    }
)
const mockCheckRateLimit = vi.hoisted(() => vi.fn(countingFake))

vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return {
    ...actual,
    checkRateLimit: mockCheckRateLimit,
    resolveClientIp: () => "203.0.113.7",
  }
})

let currentUserId = "user-1"
const mockAuth = vi.hoisted(() =>
  vi.fn(async () => ({ user: { id: currentUserId } }))
)
vi.mock("@/lib/auth", () => ({ auth: mockAuth }))

const mockSaveUserAiKey = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "key-1",
    provider: "openai",
    isEnabled: true,
    fingerprintLast4: "7890",
  }))
)
const mockTestUserAiKey = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, latencyMs: 5, model: "gpt-4o-mini" }))
)
const mockTestBrowserKey = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, latencyMs: 5, model: "gpt-4o-mini" }))
)
const mockEnableUserAiKey = vi.hoisted(() =>
  vi.fn(async () => ({ id: "key-1", provider: "openai", isEnabled: true }))
)
const mockDisableUserAiKey = vi.hoisted(() =>
  vi.fn(async () => ({ id: "key-1", provider: "openai", isEnabled: false }))
)
const mockSetUserAiBillingMode = vi.hoisted(() =>
  vi.fn(async (_userId: string, mode: string) => mode)
)
vi.mock("@sendcms/ai-settings", () => ({
  saveUserAiKey: mockSaveUserAiKey,
  testUserAiKey: mockTestUserAiKey,
  testBrowserKey: mockTestBrowserKey,
  enableUserAiKey: mockEnableUserAiKey,
  disableUserAiKey: mockDisableUserAiKey,
  setUserAiBillingMode: mockSetUserAiBillingMode,
  getUserAiBillingMode: vi.fn(async () => "PLATFORM"),
  listUserAiKeys: vi.fn(async () => []),
  getUserAiKey: vi.fn(async () => null),
  deleteUserAiKey: vi.fn(async () => {}),
}))

import { enforceCustomerAiRateLimit } from "@/lib/rate-limit"
import { POST as saveKey } from "../apps/api/app/api/v1/ai/keys/route"
import { POST as testKey } from "../apps/api/app/api/v1/ai/keys/[provider]/test/route"
import { POST as testBrowserKey } from "../apps/api/app/api/v1/ai/keys/[provider]/test-browser/route"
import { POST as enableKey } from "../apps/api/app/api/v1/ai/keys/[provider]/enable/route"
import { POST as disableKey } from "../apps/api/app/api/v1/ai/keys/[provider]/disable/route"
import { POST as setBillingMode } from "../apps/api/app/api/v1/ai/billing-mode/route"

function postJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function providerParams(provider = "openai") {
  return { params: Promise.resolve({ provider }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks does not remove per-test mockResolvedValue overrides
  // (the 429 helper test sets one) — restore the counting fake.
  mockCheckRateLimit.mockImplementation(countingFake)
  rateBuckets.clear()
  currentUserId = "user-1"
})

describe("enforceCustomerAiRateLimit", () => {
  it("allows under the general budget, keyed per user", async () => {
    const result = await enforceCustomerAiRateLimit(
      postJson("/api/v1/ai/keys", {}),
      "user-1"
    )
    expect(result).toBeNull()
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "customer-ai:user:user-1",
        minuteLimit: 60,
        hourLimit: 600,
      })
    )
  })

  it("uses the tighter budget on the test routes", async () => {
    const result = await enforceCustomerAiRateLimit(
      postJson("/api/v1/ai/keys/openai/test", {}),
      "user-1",
      true
    )
    expect(result).toBeNull()
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "customer-ai-test:user:user-1",
        minuteLimit: 5,
        hourLimit: 20,
      })
    )
  })

  it("returns 429 with Retry-After once over the limit", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
      minuteCount: 61,
      hourCount: 61,
    })
    const result = await enforceCustomerAiRateLimit(
      postJson("/api/v1/ai/keys", {}),
      "user-1"
    )
    expect(result?.status).toBe(429)
    expect(result?.headers.get("Retry-After")).toBe("42")
  })
})

describe("customer AI routes (AIM-002)", () => {
  it("the 6th test-browser call in a burst is 429; another user is unaffected", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await testBrowserKey(
        postJson("/api/v1/ai/keys/openai/test-browser", {
          apiKey: "sk-test-12345678",
        }),
        providerParams()
      )
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    expect(mockTestBrowserKey).toHaveBeenCalledTimes(5)
    currentUserId = "user-2"
    const other = await testBrowserKey(
      postJson("/api/v1/ai/keys/openai/test-browser", {
        apiKey: "sk-test-12345678",
      }),
      providerParams()
    )
    expect(other.status).toBe(200)
  })

  it("the 6th test call in a burst is 429", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await testKey(
        postJson("/api/v1/ai/keys/openai/test", {}),
        providerParams()
      )
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    expect(mockTestUserAiKey).toHaveBeenCalledTimes(5)
  })

  it("the 61st key save in a burst is 429", async () => {
    let lastStatus = 0
    for (let i = 0; i < 61; i++) {
      const res = await saveKey(
        postJson("/api/v1/ai/keys", {
          provider: "openai",
          apiKey: "sk-test-12345678",
        })
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
    expect(mockSaveUserAiKey).toHaveBeenCalledTimes(60)
  })

  it("the 61st enable in a burst is 429", async () => {
    let lastStatus = 0
    for (let i = 0; i < 61; i++) {
      const res = await enableKey(
        postJson("/api/v1/ai/keys/openai/enable", {}),
        providerParams()
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
    expect(mockEnableUserAiKey).toHaveBeenCalledTimes(60)
  })

  it("the 61st disable in a burst is 429", async () => {
    let lastStatus = 0
    for (let i = 0; i < 61; i++) {
      const res = await disableKey(
        postJson("/api/v1/ai/keys/openai/disable", {}),
        providerParams()
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
    expect(mockDisableUserAiKey).toHaveBeenCalledTimes(60)
  })

  it("the 61st billing-mode change in a burst is 429", async () => {
    let lastStatus = 0
    for (let i = 0; i < 61; i++) {
      const res = await setBillingMode(
        postJson("/api/v1/ai/billing-mode", { billingMode: "PLATFORM" })
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
    expect(mockSetUserAiBillingMode).toHaveBeenCalledTimes(60)
  })
})
