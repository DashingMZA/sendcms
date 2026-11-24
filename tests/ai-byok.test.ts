// AI provider & BYOK settings (Admin Control Plane, Phase 5) with a
// mocked Prisma client, a mocked plans entitlements lookup, and a
// mocked AI SDK generateText (for the Test button). The real
// @sendcms/ai crypto and provider plumbing run — only
// getAiModelForKey is stubbed, so the tests can prove WHICH key a
// resolution used (BYOK vs platform vs browser-only) without a live
// provider call. No test hits the real DB or a real provider.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import type { AdminSession } from "@sendcms/auth"
import type { LanguageModel } from "ai"
import type { EffectiveEntitlements } from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

const TEST_MASTER_KEY = "aa".repeat(32) // 64 hex chars = 32 bytes
const PLATFORM_KEY = "sk-platform-test-key-12345678"
const BYOK_KEY = "sk-byok-test-key-abcdef"
const BYOK_KEY_2 = "sk-byok-test-key-22222222"
const ENV = { OPENAI_API_KEY: PLATFORM_KEY }

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

// AIM-006: no meaningful fragment of a key may appear in a text
// (response body or log line). 8+ char windows catch any real echo —
// a provider redaction shows the first ~8 chars — plus the last 4
// (the fingerprint tail). 4-char windows are too strict: the fake
// keys contain ordinary words ("test", "browser") that also appear
// in the fixed messages ("Key test failed.", "userId").
function expectNoKeyFragments(text: string, key: string) {
  for (let i = 0; i + 8 <= key.length; i++) {
    expect(text).not.toContain(key.slice(i, i + 8))
  }
  expect(text).not.toContain(key.slice(-4))
  expect(text).not.toContain(key)
}

function freeEntitlements(): EffectiveEntitlements {
  return {
    entitlements: FREE_PLAN_V1_ENTITLEMENTS,
    source: "free",
    planVersionId: null,
    emergency: false,
    overriddenMeters: [],
  }
}

function entitlementsWith(
  overrides: Partial<typeof FREE_PLAN_V1_ENTITLEMENTS>
): EffectiveEntitlements {
  return {
    ...freeEntitlements(),
    entitlements: { ...FREE_PLAN_V1_ENTITLEMENTS, ...overrides },
  }
}

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@csofts.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

const ownerSession = makeSession()
const managerSession = makeSession({
  id: "manager-1",
  email: "manager@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: "MANAGER",
})
const supportSession = makeSession({
  id: "support-1",
  email: "support@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: "SUPPORT",
})

const mockLogAudit = vi.hoisted(() =>
  vi.fn(async (call: { detail?: Record<string, unknown> }) => call)
)
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))
const mockGetEffective = vi.hoisted(() => vi.fn())
const mockGetAiModelForKey = vi.hoisted(() => vi.fn())
const mockGenerateText = vi.hoisted(() => vi.fn())

// A stateful in-memory fake DB: the key tests need save → list →
// replace → delete to behave like a real store (keyVersion
// increments, rows disappear on delete). Prisma `select`/`include`
// args are ignored — the service only reads the fields it needs.
// `update`/`upsert` skip `undefined` values, like Prisma does.
const { store, mockDb } = vi.hoisted(() => {
  type StoredKey = {
    id: string
    userId: string
    provider: string
    model: string | null
    isEnabled: boolean
    keyVersion: number
    masterKeyVersion: number
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
  type StoredUser = {
    id: string
    name: string | null
    email: string
    status: string
  }
  type StoredSettings = { userId: string; billingMode: string }
  type StoredConfig = {
    id: string
    provider: string
    isEnabled: boolean
    allowedModels: string[]
    defaultModel: string | null
  }
  type StoredUsage = {
    id: string
    userId: string
    provider: string
    model: string
    billingMode: string
    tokensIn: number | null
    tokensOut: number | null
    costMicros: number | null
    status: string
    sourceEvent: string | null
    resourceId: string | null
    createdAt: Date
  }

  const store = {
    users: new Map<string, StoredUser>(),
    keys: new Map<string, StoredKey>(),
    settings: new Map<string, StoredSettings>(),
    configs: new Map<string, StoredConfig>(),
    usage: [] as StoredUsage[],
    keySeq: 1,
    usageSeq: 1,
  }

  function keyId(userId: string, provider: string): string {
    return `${userId}:${provider}`
  }

  function applyData(
    row: Record<string, unknown>,
    data: Record<string, unknown>
  ): void {
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) row[k] = v
    }
    row.updatedAt = new Date()
  }

  function matchesUsageWhere(
    row: StoredUsage,
    where: Record<string, unknown> | undefined
  ): boolean {
    if (!where) return true
    for (const [field, value] of Object.entries(where)) {
      if (field === "createdAt" && value && typeof value === "object") {
        const range = value as { gte?: Date; lte?: Date }
        if (range.gte && row.createdAt < range.gte) return false
        if (range.lte && row.createdAt > range.lte) return false
        continue
      }
      if ((row as unknown as Record<string, unknown>)[field] !== value) {
        return false
      }
    }
    return true
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
          where: { userId_provider?: { userId: string; provider: string } }
        }) => {
          if (!where.userId_provider) return null
          return (
            store.keys.get(
              keyId(
                where.userId_provider.userId,
                where.userId_provider.provider
              )
            ) ?? null
          )
        }
      ),
      findMany: vi.fn(async ({ where }: { where?: { userId?: string } }) =>
        [...store.keys.values()]
          .filter((k) => !where?.userId || k.userId === where.userId)
          .sort((a, b) => (a.provider < b.provider ? -1 : 1))
      ),
      findFirst: vi.fn(async () => store.keys.values().next().value ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredKey = {
          id: `key-${store.keySeq++}`,
          keyVersion: 1,
          isEnabled: true,
          lastTestedAt: null,
          lastTestStatus: "UNTESTED",
          masterKeyVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as unknown as Omit<
            StoredKey,
            | "id"
            | "keyVersion"
            | "isEnabled"
            | "lastTestedAt"
            | "lastTestStatus"
            | "masterKeyVersion"
            | "createdAt"
            | "updatedAt"
          >),
        }
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
          const row: StoredSettings = {
            ...(create as unknown as StoredSettings),
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
      findMany: vi.fn(async () =>
        [...store.configs.values()].sort((a, b) =>
          a.provider < b.provider ? -1 : 1
        )
      ),
      createMany: vi.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          for (const d of data) {
            const provider = d.provider as string
            if (!store.configs.has(provider)) {
              store.configs.set(provider, {
                id: `cfg-${provider}`,
                ...(d as unknown as Omit<StoredConfig, "id">),
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
          const row: StoredConfig = {
            id: `cfg-${where.provider}`,
            ...(create as unknown as Omit<StoredConfig, "id">),
          }
          store.configs.set(where.provider, row)
          return row
        }
      ),
    },
    aiUsageRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredUsage = {
          id: `usage-${store.usageSeq++}`,
          createdAt: new Date(),
          ...(data as unknown as Omit<StoredUsage, "id" | "createdAt">),
        }
        store.usage.push(row)
        return row
      }),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          store.usage.filter((r) => matchesUsageWhere(r, where)).length
      ),
      findMany: vi.fn(
        async ({
          where,
          include,
          skip = 0,
          take,
        }: {
          where?: Record<string, unknown>
          include?: { user?: boolean }
          skip?: number
          take?: number
        }) => {
          const rows = store.usage
            .filter((r) => matchesUsageWhere(r, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          const page = rows.slice(
            skip,
            take === undefined ? undefined : skip + take
          )
          if (!include?.user) return page
          return page.map((r) => {
            const user = store.users.get(r.userId)
            return {
              ...r,
              user: user
                ? { id: user.id, name: user.name, email: user.email }
                : null,
            }
          })
        }
      ),
      groupBy: vi.fn(
        async ({
          by,
          where,
          _sum,
        }: {
          by: string[]
          where?: Record<string, unknown>
          _sum?: Record<string, boolean>
        }) => {
          const rows = store.usage.filter((r) => matchesUsageWhere(r, where))
          const groups = new Map<string, Record<string, unknown>>()
          for (const r of rows) {
            const key = by
              .map((f) =>
                String((r as unknown as Record<string, unknown>)[f] ?? "")
              )
              .join("|")
            let g = groups.get(key)
            if (!g) {
              g = { _count: { _all: 0 }, _sum: {} as Record<string, number> }
              for (const f of by) {
                g[f] = (r as unknown as Record<string, unknown>)[f]
              }
              for (const f of Object.keys(_sum ?? {})) {
                ;(g._sum as Record<string, number>)[f] = 0
              }
              groups.set(key, g)
            }
            ;(g._count as { _all: number })._all += 1
            for (const f of Object.keys(_sum ?? {})) {
              ;(g._sum as Record<string, number>)[f] +=
                (r as unknown as Record<string, number>)[f] ?? 0
            }
          }
          return [...groups.values()]
        }
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockDb)
    ),
    // DB-051: the locked read in setBillingModeLocked. The template
    // tag arrives as (strings, ...values); values[0] is the userId.
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?")
        if (sql.includes('"UserAiSettings"')) {
          const row = store.settings.get(values[0] as string)
          return row ? [{ billingMode: row.billingMode }] : []
        }
        return []
      }
    ),
  }

  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
vi.mock("@sendcms/observability", () => ({
  createLogger: () => mockLogger,
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

import {
  AiNotAvailableError,
  deleteUserAiKey,
  disableUserAiKey,
  enableUserAiKey,
  getAiUsageSummary,
  getProviderHealth,
  getUserAiBillingMode,
  getUserAiKey,
  listAiUsage,
  listProviderConfigs,
  listUserAiKeys,
  listUserAiKeysForAdmin,
  recordAiUsage,
  resolveAiModelForUser,
  sanitizeKeyTestError,
  saveUserAiKey,
  setProviderConfig,
  setUserAiBillingMode,
  setUserAiBillingModeForAdmin,
  testBrowserKey,
  testUserAiKey,
} from "@sendcms/ai-settings"
import { decryptByokKey } from "@sendcms/ai"
import { SaveAiKeySchema } from "@sendcms/ai-settings/validators"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("AI_BYOK_MASTER_KEY", TEST_MASTER_KEY)
  store.users.clear()
  store.keys.clear()
  store.settings.clear()
  store.configs.clear()
  store.usage.length = 0
  store.keySeq = 1
  store.usageSeq = 1
  store.users.set("user-1", {
    id: "user-1",
    name: "User One",
    email: "user1@example.com",
    status: "ACTIVE",
  })
  store.users.set("user-2", {
    id: "user-2",
    name: "User Two",
    email: "user2@example.com",
    status: "ACTIVE",
  })
  store.users.set("suspended-1", {
    id: "suspended-1",
    name: "Suspended",
    email: "susp@example.com",
    status: "SUSPENDED",
  })
  mockGetEffective.mockResolvedValue(freeEntitlements())
  // Tag the model with the last 4 chars of the key it was built
  // from, so the tests can prove WHICH key a resolution used.
  mockGetAiModelForKey.mockImplementation(
    (provider: string, apiKey: string, modelId?: string) =>
      ({
        provider,
        modelId: modelId ?? "test-model",
        keyLast4: apiKey.slice(-4),
      }) as unknown as LanguageModel
  )
  mockGenerateText.mockResolvedValue({
    usage: { inputTokens: 5, outputTokens: 1 },
  })
})

function storedKeyRow() {
  return [...store.keys.values()][0]
}

function decryptStoredKey(
  row: {
    userId: string
    encryptedKey: string
    encryptedDek: string
    keyIv: string
    keyTag: string
  },
  provider = "openai"
): string {
  // The AAD binds the LOWERCASE provider name.
  return decryptByokKey({ ...row, provider })
}

describe("saveUserAiKey", () => {
  it("stores the key encrypted — the stored row contains no plaintext", async () => {
    const meta = await saveUserAiKey("user-1", {
      provider: "openai",
      apiKey: BYOK_KEY,
    })
    expect(meta.provider).toBe("openai")
    expect(meta.keyVersion).toBe(1)
    expect(meta.isEnabled).toBe(true)
    expect(meta.lastTestStatus).toBe("UNTESTED")
    expect(meta.fingerprintLast4).toBe(sha256(BYOK_KEY).slice(-4))
    const row = storedKeyRow()
    // No plaintext anywhere in the stored row.
    for (const value of Object.values(row)) {
      if (typeof value === "string") expect(value).not.toContain(BYOK_KEY)
    }
    expect(row.encryptedKey).not.toBe(BYOK_KEY)
    expect(row.keyFingerprint).toBe(sha256(BYOK_KEY))
    // ... and it round-trips through decrypt.
    expect(decryptStoredKey(row)).toBe(BYOK_KEY)
    // Metadata only — no key material on the returned object.
    expect(meta).not.toHaveProperty("encryptedKey")
    expect(meta).not.toHaveProperty("encryptedDek")
    expect(meta).not.toHaveProperty("keyIv")
    expect(meta).not.toHaveProperty("keyTag")
  })

  it("replaces a key for the same provider and increments keyVersion", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    const second = await saveUserAiKey("user-1", {
      provider: "openai",
      apiKey: BYOK_KEY_2,
    })
    expect(second.keyVersion).toBe(2)
    expect(await listUserAiKeys("user-1")).toHaveLength(1)
    expect(decryptStoredKey(storedKeyRow())).toBe(BYOK_KEY_2)
  })

  it("audits the save with provider + fingerprint only", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: "AI_KEY",
        detail: expect.objectContaining({
          event: "byok-key-saved",
          provider: "openai",
        }),
      })
    )
    const firstCall = mockLogAudit.mock.calls[0]
    expect(firstCall).toBeDefined()
    const detail = firstCall![0].detail as Record<string, unknown>
    expect(JSON.stringify(detail)).not.toContain(BYOK_KEY)
    expect(JSON.stringify(detail)).not.toContain("sk-")
  })

  it("refuses a key for a provider the plan forbids", async () => {
    mockGetEffective.mockResolvedValue(entitlementsWith({ aiProviders: [] }))
    await expect(
      saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("refuses to save a key for a suspended user", async () => {
    await expect(
      saveUserAiKey("suspended-1", { provider: "openai", apiKey: BYOK_KEY })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("rejects a too-short key at the route schema", () => {
    expect(
      SaveAiKeySchema.safeParse({ provider: "openai", apiKey: "short" }).success
    ).toBe(false)
    expect(
      SaveAiKeySchema.safeParse({ provider: "openai", apiKey: BYOK_KEY })
        .success
    ).toBe(true)
  })
})

describe("list/get/enable/disable/delete", () => {
  it("lists metadata only — never key material", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await saveUserAiKey("user-1", {
      provider: "anthropic",
      apiKey: "sk-ant-test-key-12345678",
    })
    const keys = await listUserAiKeys("user-1")
    expect(keys).toHaveLength(2)
    for (const k of keys) {
      expect(k).not.toHaveProperty("encryptedKey")
      expect(k).not.toHaveProperty("encryptedDek")
      expect(k).not.toHaveProperty("keyIv")
      expect(k).not.toHaveProperty("keyTag")
      expect(k.fingerprintLast4).toHaveLength(4)
    }
    expect(JSON.stringify(keys)).not.toContain(BYOK_KEY)
  })

  it("gets one key's metadata and 404s when missing", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    expect((await getUserAiKey("user-1", "openai")).provider).toBe("openai")
    await expect(getUserAiKey("user-1", "google")).rejects.toMatchObject({
      status: 404,
    })
  })

  it("disables and re-enables a key", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    expect((await disableUserAiKey("user-1", "openai")).isEnabled).toBe(false)
    expect((await enableUserAiKey("user-1", "openai")).isEnabled).toBe(true)
  })

  it("deletes a key and audits the delete", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await deleteUserAiKey("user-1", "openai")
    expect(await listUserAiKeys("user-1")).toHaveLength(0)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELETE",
        detail: expect.objectContaining({ event: "byok-key-deleted" }),
      })
    )
  })
})

describe("testUserAiKey", () => {
  it("tests a saved key live and records a BYOK usage row", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    const result = await testUserAiKey("user-1", "openai")
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.model).toBe("gpt-4o-mini")
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    // The test used the BYOK key, not the platform key.
    expect(mockGetAiModelForKey).toHaveBeenCalledWith(
      "openai",
      BYOK_KEY,
      "gpt-4o-mini"
    )
    expect(storedKeyRow().lastTestStatus).toBe("OK")
    expect(storedKeyRow().lastTestedAt).not.toBeNull()
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0]).toMatchObject({
      billingMode: "BYOK",
      status: "SUCCESS",
      sourceEvent: "key-test",
      tokensIn: 5,
      tokensOut: 1,
    })
  })

  it("records a FAILED test and never falls back to the platform key", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    mockGenerateText.mockRejectedValueOnce(
      new Error("Incorrect API key provided")
    )
    const result = await testUserAiKey("user-1", "openai")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Incorrect API key")
    expect(result.error).not.toContain(BYOK_KEY)
    expect(storedKeyRow().lastTestStatus).toBe("FAILED")
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0]).toMatchObject({
      billingMode: "BYOK",
      status: "FAILED",
      sourceEvent: "key-test",
    })
    // The platform key was never used for this test.
    expect(mockGetAiModelForKey).toHaveBeenCalledTimes(1)
    expect(mockGetAiModelForKey.mock.calls[0][1]).toBe(BYOK_KEY)
  })

  it("404s when no key is saved", async () => {
    await expect(testUserAiKey("user-1", "openai")).rejects.toMatchObject({
      status: 404,
    })
  })

  // AIM-005/AIM-020 follow-through (Wave 2 coordinator): a key test
  // resolves a model for a live probe, so a DISABLED billing mode
  // refuses it — no probe call, no usage row.
  it("refuses to probe when the billing mode is DISABLED", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await setUserAiBillingMode("user-1", "DISABLED")
    await expect(testUserAiKey("user-1", "openai")).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("disabled"),
    })
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(store.usage).toHaveLength(0)
  })

  // AIM-006: the provider's auth error quotes the key's first ~8 and
  // last 4 chars (OpenAI's own redaction). Neither the response nor
  // the structured log may carry any 4+ char fragment of the key.
  it("never echoes key fragments when the provider error quotes the key", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    mockGenerateText.mockRejectedValueOnce(
      new Error(
        `Incorrect API key provided: ${BYOK_KEY.slice(0, 8)}${"*".repeat(24)}${BYOK_KEY.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.`
      )
    )
    const result = await testUserAiKey("user-1", "openai")
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Incorrect API key.")
    expectNoKeyFragments(result.error ?? "", BYOK_KEY)
    const warnCall = mockLogger.warn.mock.calls.find(
      (call) => call[0] === "byok key test failed"
    )
    expect(warnCall).toBeDefined()
    expectNoKeyFragments(JSON.stringify(warnCall?.[1] ?? {}), BYOK_KEY)
    expect(warnCall?.[1]).toMatchObject({
      fingerprintLast4: sha256(BYOK_KEY).slice(-4),
    })
  })
})

describe("sanitizeKeyTestError", () => {
  it("maps rate-limit and overload errors to safe messages", () => {
    expect(
      sanitizeKeyTestError("Rate limit reached for gpt-4o-mini", BYOK_KEY)
    ).toBe("Rate limit exceeded. Try again later.")
    expect(
      sanitizeKeyTestError(
        "The model is overloaded. Please try again.",
        BYOK_KEY
      )
    ).toBe("The provider is overloaded. Try again later.")
  })

  it("falls back to a generic message for unknown errors", () => {
    expect(sanitizeKeyTestError("Something exploded", BYOK_KEY)).toBe(
      "Key test failed."
    )
  })

  it("drops key fragments even when no allowlisted phrase matches", () => {
    const sanitised = sanitizeKeyTestError(
      `Bad gateway for ${BYOK_KEY}`,
      BYOK_KEY
    )
    expect(sanitised).toBe("Key test failed.")
    expectNoKeyFragments(sanitised, BYOK_KEY)
  })
})

describe("testBrowserKey", () => {
  const BROWSER_KEY = "sk-browser-only-key-12345"

  it("tests a browser-only key live without storing it", async () => {
    const result = await testBrowserKey("user-1", "openai", BROWSER_KEY)
    expect(result.ok).toBe(true)
    expect(result.model).toBe("gpt-4o-mini")
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    // The test used the browser key, not the platform key.
    expect(mockGetAiModelForKey).toHaveBeenCalledWith(
      "openai",
      BROWSER_KEY,
      "gpt-4o-mini"
    )
    // Nothing was stored: no key row exists for this user.
    expect(store.keys.size).toBe(0)
    // The usage row is attributed (BYOK, key-test) with no resourceId.
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0]).toMatchObject({
      billingMode: "BYOK",
      status: "SUCCESS",
      sourceEvent: "key-test",
      tokensIn: 5,
      tokensOut: 1,
      resourceId: null,
    })
    // The key itself is nowhere in the stored records.
    expect(JSON.stringify(store.usage)).not.toContain(BROWSER_KEY)
  })

  it("records a FAILED browser test and never falls back to the platform key", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error("Incorrect API key provided")
    )
    const result = await testBrowserKey("user-1", "openai", BROWSER_KEY)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Incorrect API key")
    expect(result.error).not.toContain(BROWSER_KEY)
    expect(store.keys.size).toBe(0)
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0]).toMatchObject({
      billingMode: "BYOK",
      status: "FAILED",
      sourceEvent: "key-test",
    })
    expect(mockGetAiModelForKey).toHaveBeenCalledTimes(1)
    expect(mockGetAiModelForKey.mock.calls[0][1]).toBe(BROWSER_KEY)
  })

  // AIM-006: same key-echo rule for a browser-only key (which has no
  // stored fingerprint to log instead).
  it("never echoes key fragments when the provider error quotes the browser key", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error(
        `Incorrect API key provided: ${BROWSER_KEY.slice(0, 8)}${"*".repeat(20)}${BROWSER_KEY.slice(-4)}.`
      )
    )
    const result = await testBrowserKey("user-1", "openai", BROWSER_KEY)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Incorrect API key.")
    expectNoKeyFragments(result.error ?? "", BROWSER_KEY)
    const warnCall = mockLogger.warn.mock.calls.find(
      (call) => call[0] === "browser key test failed"
    )
    expect(warnCall).toBeDefined()
    expectNoKeyFragments(JSON.stringify(warnCall?.[1] ?? {}), BROWSER_KEY)
  })

  it("rejects a too-short key without calling the provider", async () => {
    await expect(
      testBrowserKey("user-1", "openai", "short")
    ).rejects.toMatchObject({ status: 422 })
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(store.usage).toHaveLength(0)
  })

  // AIM-005/AIM-020 follow-through (Wave 2 coordinator): a browser-key
  // probe resolves a model, so DISABLED mode and suspended accounts
  // refuse it before any provider call.
  it("refuses to probe when the billing mode is DISABLED", async () => {
    await setUserAiBillingMode("user-1", "DISABLED")
    await expect(
      testBrowserKey("user-1", "openai", BROWSER_KEY)
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("disabled"),
    })
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(store.usage).toHaveLength(0)
  })

  it("refuses to probe for a suspended user", async () => {
    await expect(
      testBrowserKey("suspended-1", "openai", BROWSER_KEY)
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("not available"),
    })
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(store.usage).toHaveLength(0)
  })
})

describe("billing mode", () => {
  it("defaults to PLATFORM with no settings row", async () => {
    expect(await getUserAiBillingMode("user-1")).toBe("PLATFORM")
  })

  it("sets BYOK when the plan allows it, and audits the change", async () => {
    expect(await setUserAiBillingMode("user-1", "BYOK")).toBe("BYOK")
    expect(await getUserAiBillingMode("user-1")).toBe("BYOK")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "USER",
        detail: expect.objectContaining({
          event: "ai-billing-mode-changed",
          billingMode: "BYOK",
          previousBillingMode: "PLATFORM",
        }),
      })
    )
  })

  it("rejects BYOK when the plan forbids it", async () => {
    mockGetEffective.mockResolvedValue(
      entitlementsWith({ aiByokAllowed: false })
    )
    await expect(setUserAiBillingMode("user-1", "BYOK")).rejects.toMatchObject({
      status: 403,
    })
    expect(await getUserAiBillingMode("user-1")).toBe("PLATFORM")
  })

  it("rejects PLATFORM when the plan forbids it", async () => {
    mockGetEffective.mockResolvedValue(
      entitlementsWith({ aiPlatformAllowed: false })
    )
    await expect(
      setUserAiBillingMode("user-1", "PLATFORM")
    ).rejects.toMatchObject({ status: 403 })
  })

  it("always allows DISABLED", async () => {
    expect(await setUserAiBillingMode("user-1", "DISABLED")).toBe("DISABLED")
  })

  it("refuses BYOK for a suspended user", async () => {
    await expect(
      setUserAiBillingMode("suspended-1", "BYOK")
    ).rejects.toMatchObject({ status: 403 })
  })

  it("lets an admin set another user's mode; a manager without MANAGE_AI cannot", async () => {
    expect(
      await setUserAiBillingModeForAdmin(ownerSession, "user-1", "BYOK")
    ).toBe("BYOK")
    await expect(
      setUserAiBillingModeForAdmin(managerSession, "user-2", "BYOK")
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("resolveAiModelForUser", () => {
  it("uses the BYOK key first when the mode is BYOK", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await setUserAiBillingMode("user-1", "BYOK")
    const resolved = await resolveAiModelForUser("user-1", {
      purpose: "suggest-fields",
      env: ENV,
    })
    expect(resolved.billingMode).toBe("BYOK")
    expect(resolved.provider).toBe("openai")
    expect(resolved.modelId).toBe("gpt-4o-mini")
    expect((resolved.model as unknown as { keyLast4: string }).keyLast4).toBe(
      "cdef"
    )
  })

  it("uses the platform key when the mode is PLATFORM", async () => {
    const resolved = await resolveAiModelForUser("user-1", {
      purpose: "suggest-fields",
      env: ENV,
    })
    expect(resolved.billingMode).toBe("PLATFORM")
    expect(resolved.provider).toBe("openai")
    expect((resolved.model as unknown as { keyLast4: string }).keyLast4).toBe(
      "5678"
    )
  })

  it("throws when BYOK is selected but no key is saved — never falls back to platform", async () => {
    await setUserAiBillingMode("user-1", "BYOK")
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toBeInstanceOf(AiNotAvailableError)
    // The platform key was never built.
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("throws when the BYOK key is disabled — never falls back to platform", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await disableUserAiKey("user-1", "openai")
    await setUserAiBillingMode("user-1", "BYOK")
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toMatchObject({ status: 503 })
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("throws when a stored BYOK key cannot be decrypted — never falls back to platform", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await setUserAiBillingMode("user-1", "BYOK")
    // Tamper with the ciphertext: the GCM tag no longer verifies.
    storedKeyRow().encryptedKey = Buffer.from("tampered").toString("base64")
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toMatchObject({ status: 503 })
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("throws for a provider with no stored key even when another provider has one", async () => {
    await saveUserAiKey("user-1", {
      provider: "anthropic",
      apiKey: "sk-ant-test-key-12345678",
    })
    await setUserAiBillingMode("user-1", "BYOK")
    await expect(
      resolveAiModelForUser("user-1", {
        purpose: "suggest-fields",
        provider: "openai",
        env: ENV,
      })
    ).rejects.toMatchObject({ status: 503 })
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("uses a browser-only key for one call and never persists it", async () => {
    const resolved = await resolveAiModelForUser("user-1", {
      purpose: "suggest-fields",
      provider: "deepseek",
      browserKey: "sk-browser-key-99999999",
      env: ENV,
    })
    expect(resolved.billingMode).toBe("BYOK")
    expect(resolved.provider).toBe("deepseek")
    expect((resolved.model as unknown as { keyLast4: string }).keyLast4).toBe(
      "9999"
    )
    expect(store.keys.size).toBe(0)
  })

  it("refuses a browser-only key without a provider", async () => {
    await expect(
      resolveAiModelForUser("user-1", {
        purpose: "suggest-fields",
        browserKey: "sk-browser-key-99999999",
        env: ENV,
      })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("throws when the mode is DISABLED", async () => {
    await setUserAiBillingMode("user-1", "DISABLED")
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("DISABLED wins over a browser-only key (AIM-005 / AIM-020)", async () => {
    await setUserAiBillingMode("user-1", "DISABLED")
    await expect(
      resolveAiModelForUser("user-1", {
        purpose: "suggest-fields",
        provider: "openai",
        browserKey: "sk-browser-key-99999999",
        env: ENV,
      })
    ).rejects.toMatchObject({ status: 503 })
    // No model was built from the browser key.
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("DISABLED wins over a stored BYOK key (AIM-005 / AIM-020)", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await setUserAiBillingMode("user-1", "DISABLED")
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toMatchObject({ status: 503 })
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("PLATFORM mode still resolves a browser-only key", async () => {
    await setUserAiBillingMode("user-1", "PLATFORM")
    const resolved = await resolveAiModelForUser("user-1", {
      purpose: "suggest-fields",
      provider: "openai",
      browserKey: "sk-browser-key-99999999",
      env: ENV,
    })
    expect(resolved.billingMode).toBe("BYOK")
    expect(resolved.provider).toBe("openai")
    expect((resolved.model as unknown as { keyLast4: string }).keyLast4).toBe(
      "9999"
    )
  })

  it("throws when the emergency switch is on, even with a browser-only key", async () => {
    mockGetEffective.mockResolvedValue({
      ...freeEntitlements(),
      emergency: true,
    })
    await expect(
      resolveAiModelForUser("user-1", {
        purpose: "suggest-fields",
        provider: "openai",
        browserKey: "sk-browser-key-99999999",
        env: ENV,
      })
    ).rejects.toMatchObject({ status: 503 })
    expect(mockGetAiModelForKey).not.toHaveBeenCalled()
  })

  it("throws when the emergency switch is on (no browser key)", async () => {
    mockGetEffective.mockResolvedValue({
      ...freeEntitlements(),
      emergency: true,
    })
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: ENV })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("throws for a suspended user", async () => {
    await expect(
      resolveAiModelForUser("suspended-1", {
        purpose: "suggest-fields",
        env: ENV,
      })
    ).rejects.toMatchObject({ status: 503 })
  })

  it("throws when nothing is configured (platform mode, no platform key)", async () => {
    await expect(
      resolveAiModelForUser("user-1", { purpose: "suggest-fields", env: {} })
    ).rejects.toMatchObject({ status: 503 })
  })
})

describe("usage reporting", () => {
  it("separates BYOK and PLATFORM usage in the summary", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await testUserAiKey("user-1", "openai") // BYOK, SUCCESS, 5 in / 1 out
    await recordAiUsage({
      userId: "user-1",
      provider: "openai",
      model: "gpt-4o-mini",
      billingMode: "PLATFORM",
      status: "SUCCESS",
      tokensIn: 10,
      tokensOut: 2,
      sourceEvent: "suggest-fields",
      resourceId: "form-1",
    })
    await recordAiUsage({
      userId: "user-1",
      provider: "openai",
      model: "gpt-4o-mini",
      billingMode: "PLATFORM",
      status: "FAILED",
      sourceEvent: "suggest-fields",
      resourceId: "form-1",
    })
    const summary = await getAiUsageSummary(ownerSession, {})
    expect(summary.byok).toMatchObject({
      calls: 1,
      success: 1,
      failed: 0,
      tokensIn: 5,
      tokensOut: 1,
    })
    expect(summary.platform).toMatchObject({
      calls: 2,
      success: 1,
      failed: 1,
      tokensIn: 10,
      tokensOut: 2,
    })
    expect(summary.total.calls).toBe(3)
  })

  it("lists usage with filters and pagination", async () => {
    await recordAiUsage({
      userId: "user-1",
      provider: "openai",
      model: "gpt-4o-mini",
      billingMode: "BYOK",
      status: "SUCCESS",
      sourceEvent: "key-test",
    })
    await recordAiUsage({
      userId: "user-2",
      provider: "google",
      model: "gemini-3.5-flash-lite",
      billingMode: "PLATFORM",
      status: "SUCCESS",
      sourceEvent: "suggest-fields",
    })
    const page = await listAiUsage(ownerSession, {
      page: 1,
      perPage: 20,
      billingMode: "BYOK",
    })
    expect(page.total).toBe(1)
    expect(page.usage[0]).toMatchObject({
      billingMode: "BYOK",
      provider: "openai",
    })
    expect(page.usage[0].user?.email).toBe("user1@example.com")
    const all = await listAiUsage(ownerSession, { page: 1, perPage: 1 })
    expect(all.total).toBe(2)
    expect(all.usage).toHaveLength(1)
    expect(all.totalPages).toBe(2)
  })

  it("refuses usage reads without VIEW_AI_USAGE; a manager has it", async () => {
    await expect(
      listAiUsage(supportSession, { page: 1, perPage: 20 })
    ).rejects.toMatchObject({ status: 403 })
    const page = await listAiUsage(managerSession, { page: 1, perPage: 20 })
    expect(page.total).toBe(0)
  })
})

describe("admin provider config and user keys", () => {
  it("auto-creates all five provider configs on first read", async () => {
    const configs = await listProviderConfigs(ownerSession)
    expect(configs).toHaveLength(5)
    expect(configs.map((c) => c.provider).sort()).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "openai",
      "openrouter",
    ])
    expect(configs.every((c) => c.isEnabled)).toBe(true)
    // A second read does not duplicate them.
    expect((await listProviderConfigs(ownerSession)).length).toBe(5)
  })

  it("lets an admin disable a provider; a manager cannot", async () => {
    const updated = await setProviderConfig(ownerSession, "openai", {
      isEnabled: false,
    })
    expect(updated.isEnabled).toBe(false)
    await expect(
      setProviderConfig(managerSession, "openai", { isEnabled: false })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "ai-provider-config-changed",
          provider: "openai",
        }),
      })
    )
  })

  it("reports per-provider health with counts only", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    await testUserAiKey("user-1", "openai")
    const health = await getProviderHealth(ownerSession, ENV)
    const openai = health.find((h) => h.provider === "openai")
    expect(openai).toMatchObject({
      isEnabled: true,
      platformKeyConfigured: true,
      calls24h: 1,
      failed24h: 0,
      errorRate: 0,
    })
    expect(health).toHaveLength(5)
  })

  it("shows an admin a user's key metadata only; a manager without MANAGE_AI cannot", async () => {
    await saveUserAiKey("user-1", { provider: "openai", apiKey: BYOK_KEY })
    const keys = await listUserAiKeysForAdmin(ownerSession, "user-1")
    expect(keys).toHaveLength(1)
    expect(JSON.stringify(keys)).not.toContain(BYOK_KEY)
    await expect(
      listUserAiKeysForAdmin(managerSession, "user-1")
    ).rejects.toMatchObject({ status: 403 })
  })
})
