// Wave 8, Stream C — BYOK error path (ADM-061 / DSH-301 / TST-014).
//
// The live BYOK save/test is NOT PERFORMED (no master key in dev —
// the owner generates it). These tests pin the error path with a
// test double, exactly as the task requires: unset master key →
// actionable 503 (never a generic 500), terms gate, auto-disable
// after repeated provider rejections, and handleApiError mapping.
import { beforeEach, describe, expect, it, vi } from "vitest"

const TEST_MASTER_KEY = "aa".repeat(32) // 64 hex chars = 32 bytes
const BYOK_KEY = "sk-test-byok-key-1234567890abcdef"

const mockGetEffective = vi.hoisted(() => vi.fn())
const mockGetAiModelForKey = vi.hoisted(() => vi.fn())
const mockGenerateText = vi.hoisted(() => vi.fn())

const { store, mockDb } = vi.hoisted(() => {
  type StoredKey = {
    id: string
    userId: string
    provider: string
    model: string | null
    isEnabled: boolean
    keyVersion: number
    masterKeyVersion: number
    authFailureCount: number
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
    keyFingerprint: string
    lastTestedAt: Date | null
    lastTestStatus: "OK" | "FAILED" | "UNTESTED"
    createdAt: Date
    updatedAt: Date
  }
  const store = {
    users: new Map<string, { id: string; status: string }>(),
    keys: new Map<string, StoredKey>(),
    settings: new Map<string, { userId: string; billingMode: string }>(),
    configs: new Map<
      string,
      {
        id: string
        provider: string
        isEnabled: boolean
        allowedModels: string[]
        defaultModel: string | null
      }
    >(),
    usage: [] as Record<string, unknown>[],
    keySeq: 1,
  }
  function keyId(userId: string, provider: string): string {
    return `${userId}:${provider}`
  }
  function applyData(
    row: Record<string, unknown>,
    data: Record<string, unknown>
  ): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue
      if (v && typeof v === "object" && "increment" in v) {
        row[k] = (row[k] as number) + (v as { increment: number }).increment
        continue
      }
      row[k] = v
    }
    row.updatedAt = new Date()
  }
  const mockDb = {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.users.get(where.id) ?? null
      ),
    },
    userAiKey: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { userId_provider: { userId: string; provider: string } }
        }) =>
          store.keys.get(
            keyId(where.userId_provider.userId, where.userId_provider.provider)
          ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where?: { userId?: string } }) =>
        [...store.keys.values()].filter(
          (k) => !where?.userId || k.userId === where.userId
        )
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `key-${store.keySeq++}`,
          keyVersion: 1,
          isEnabled: true,
          lastTestedAt: null,
          lastTestStatus: "UNTESTED",
          masterKeyVersion: 1,
          authFailureCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as Record<string, unknown>),
        } as unknown as StoredKey
        store.keys.set(keyId(row.userId, row.provider), row)
        return row
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = [...store.keys.values()].find((k) => k.id === where.id)
          if (!row) throw new Error("Record not found")
          applyData(row as unknown as Record<string, unknown>, data)
          return row
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          let count = 0
          for (const row of store.keys.values()) {
            let match = true
            for (const [field, value] of Object.entries(where)) {
              const current = (row as unknown as Record<string, unknown>)[field]
              if (
                value &&
                typeof value === "object" &&
                "gt" in (value as Record<string, unknown>)
              ) {
                if (!(
                  typeof current === "number" &&
                  current > (value as { gt: number }).gt
                ))
                  match = false
              } else if (current !== value) {
                match = false
              }
            }
            if (match) {
              applyData(row as unknown as Record<string, unknown>, data)
              count++
            }
          }
          return { count }
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_provider: { userId: string; provider: string } }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const existing =
            store.keys.get(
              keyId(
                where.userId_provider.userId,
                where.userId_provider.provider
              )
            ) ?? null
          if (existing) {
            applyData(existing as unknown as Record<string, unknown>, update)
            return existing
          }
          const row = {
            id: `key-${store.keySeq++}`,
            keyVersion: 1,
            isEnabled: true,
            lastTestedAt: null,
            lastTestStatus: "UNTESTED",
            masterKeyVersion: 1,
            authFailureCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...(create as Record<string, unknown>),
          } as unknown as StoredKey
          store.keys.set(keyId(row.userId, row.provider), row)
          return row
        }
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = [...store.keys.values()].find((k) => k.id === where.id)
        if (row) store.keys.delete(keyId(row.userId, row.provider))
        return row ?? null
      }),
    },
    userAiSettings: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) =>
          store.settings.get(where.userId) ?? null
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const existing = store.settings.get(where.userId)
          if (existing) {
            applyData(existing as unknown as Record<string, unknown>, update)
            return existing
          }
          const row = {
            ...(create as unknown as { userId: string; billingMode: string }),
          }
          store.settings.set(where.userId, row)
          return row
        }
      ),
    },
    aiProviderConfig: {
      findUnique: vi.fn(
        async ({ where }: { where: { provider: string } }) =>
          store.configs.get(where.provider) ?? null
      ),
      findMany: vi.fn(async () => [...store.configs.values()]),
      createMany: vi.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          for (const d of data) {
            const provider = d.provider as string
            if (!store.configs.has(provider)) {
              store.configs.set(provider, {
                id: `cfg-${provider}`,
                ...(d as unknown as {
                  provider: string
                  isEnabled: boolean
                  allowedModels: string[]
                  defaultModel: string | null
                }),
              })
            }
          }
          return { count: data.length }
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { provider: string }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const existing = store.configs.get(where.provider)
          if (existing) {
            applyData(existing as unknown as Record<string, unknown>, update)
            return existing
          }
          const row = {
            id: `cfg-${where.provider}`,
            ...(create as unknown as {
              provider: string
              isEnabled: boolean
              allowedModels: string[]
              defaultModel: string | null
            }),
          }
          store.configs.set(where.provider, row)
          return row
        }
      ),
    },
    aiUsageRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `usage-${store.usage.length + 1}`,
          createdAt: new Date(),
          ...data,
        }
        store.usage.push(row)
        return row
      }),
      groupBy: vi.fn(async () => []),
    },
    form: { findMany: vi.fn(async () => []) },
    aiDailyUsage: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ calls: 1 })),
    },
    aiDailyOwnerUsage: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ calls: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockDb)
    ),
    $executeRaw: vi.fn(async () => undefined),
    $queryRaw: vi.fn(async () => []),
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock("@sendcms/observability", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, getEffectiveEntitlementsSafe: mockGetEffective }
})
vi.mock("@sendcms/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/ai")>()
  return { ...actual, getAiModelForKey: mockGetAiModelForKey }
})
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateText: mockGenerateText }
})

import type { EffectiveEntitlements } from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"
import {
  listUserAiKeys,
  resolveAiModelForUser,
  saveUserAiKey,
  setUserAiBillingMode,
  testUserAiKey,
} from "@sendcms/ai-settings"
import { ApiError } from "@sendcms/shared"
import { handleApiError } from "@sendcms/api-client"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("AI_BYOK_MASTER_KEY", TEST_MASTER_KEY)
  store.users.clear()
  store.keys.clear()
  store.settings.clear()
  store.configs.clear()
  store.usage.length = 0
  store.keySeq = 1
  store.users.set("user-1", { id: "user-1", status: "ACTIVE" })
  mockGetEffective.mockResolvedValue({
    entitlements: FREE_PLAN_V1_ENTITLEMENTS,
    source: "free",
    planVersionId: null,
    emergency: false,
    overriddenMeters: [],
  } as EffectiveEntitlements)
  mockGetAiModelForKey.mockImplementation(
    (_provider: string, _apiKey: string, modelId?: string) =>
      ({ modelId: modelId ?? "gpt-4o-mini" }) as never
  )
  mockGenerateText.mockResolvedValue({
    text: "ok",
    usage: { inputTokens: 5, outputTokens: 1 },
  })
})

async function saveKey() {
  return saveUserAiKey("user-1", {
    provider: "openai",
    apiKey: BYOK_KEY,
    termsAcknowledged: true,
  })
}

describe("ADM-061: unset master key → actionable 503, never a generic 500", () => {
  it("saveUserAiKey rejects 503 naming AI_BYOK_MASTER_KEY when it is unset", async () => {
    vi.stubEnv("AI_BYOK_MASTER_KEY", "")
    await expect(
      saveUserAiKey("user-1", {
        provider: "openai",
        apiKey: BYOK_KEY,
        termsAcknowledged: true,
      })
    ).rejects.toMatchObject({ status: 503 })
    await expect(
      saveUserAiKey("user-1", {
        provider: "openai",
        apiKey: BYOK_KEY,
        termsAcknowledged: true,
      })
    ).rejects.toThrow(/AI_BYOK_MASTER_KEY is not set/)
    // And the route-level mapping keeps the 503 + message (TST-014):
    // a plain Error would collapse to a generic 500 instead.
    try {
      await saveUserAiKey("user-1", {
        provider: "openai",
        apiKey: BYOK_KEY,
        termsAcknowledged: true,
      })
      expect.unreachable()
    } catch (err) {
      const res = handleApiError(err)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain("AI_BYOK_MASTER_KEY")
    }
    expect(store.keys.size).toBe(0)
  })

  it("saves fine once the master key is set", async () => {
    const meta = await saveKey()
    expect(meta.provider).toBe("openai")
    expect(meta.isEnabled).toBe(true)
    expect(store.keys.size).toBe(1)
  })
})

describe("AIM-025: provider-terms gate on server saves", () => {
  it("refuses a server save without the acknowledgement (422)", async () => {
    await expect(
      saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      saveUserAiKey("user-1", {
        provider: "openai",
        apiKey: BYOK_KEY,
        termsAcknowledged: false,
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(store.keys.size).toBe(0)
  })

  it("saves with the acknowledgement", async () => {
    await expect(saveKey()).resolves.toMatchObject({ provider: "openai" })
  })
})

describe("AIM-003: auto-disable after repeated provider rejections", () => {
  it("disables the key after 3 auth failures, and resolution then refuses it (503)", async () => {
    await setUserAiBillingMode("user-1", "BYOK")
    await saveKey()
    const authError = () =>
      Object.assign(new Error("Incorrect API key provided"), {
        statusCode: 401,
      })
    for (let i = 0; i < 3; i++) {
      mockGenerateText.mockRejectedValueOnce(authError())
      const result = await testUserAiKey("user-1", "openai")
      expect(result.ok).toBe(false)
    }
    const [key] = await listUserAiKeys("user-1")
    expect(key.authFailureCount).toBe(3)
    expect(key.isEnabled).toBe(false)
    // A disabled key never resolves — no fallback to the platform key.
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields" })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("a timeout failure does NOT disable the key", async () => {
    await saveKey()
    const timeout = new Error("The operation timed out")
    timeout.name = "AbortError"
    mockGenerateText.mockRejectedValueOnce(timeout)
    const result = await testUserAiKey("user-1", "openai")
    expect(result.ok).toBe(false)
    const [key] = await listUserAiKeys("user-1")
    expect(key.authFailureCount).toBe(0)
    expect(key.isEnabled).toBe(true)
  })

  it("a successful test resets the failure counter", async () => {
    await saveKey()
    mockGenerateText.mockRejectedValueOnce(
      Object.assign(new Error("Incorrect API key provided"), {
        statusCode: 401,
      })
    )
    expect((await testUserAiKey("user-1", "openai")).ok).toBe(false)
    expect((await listUserAiKeys("user-1"))[0].authFailureCount).toBe(1)
    expect((await testUserAiKey("user-1", "openai")).ok).toBe(true)
    expect((await listUserAiKeys("user-1"))[0].authFailureCount).toBe(0)
  })
})

describe("TST-014: handleApiError mapping", () => {
  it("maps a plain Error to a generic 500 with no leak", async () => {
    const res = handleApiError(new Error("db password hunter2 exploded"))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Internal server error")
    expect(body.error).not.toContain("hunter2")
  })

  it("passes an ApiError through with its own status and message", async () => {
    const res = handleApiError(
      new ApiError("You have reached your daily AI limit.", 429)
    )
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("daily AI limit")
  })

  it("maps a Prisma unique-violation to 409", async () => {
    const prismaError = Object.assign(new Error("Unique constraint failed"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    })
    const res = handleApiError(prismaError)
    expect(res.status).toBe(409)
  })
})
