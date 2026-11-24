// API key service gates (Phase 11) with a mocked Prisma client.
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  apiKey: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    // Async like the real Prisma client — resolveApiKey chains .catch()
    // on this call, and a plain vi.fn() returns undefined.
    update: vi.fn(async () => ({})),
  },
  // The real plan-limit check (checkLimitStrict, SRC-216) runs
  // against these: no subscription, no overrides, the default Free
  // plan (whose apiKeys cap is 10, matching MAX_ACTIVE_API_KEYS).
  entitlementOverride: { findMany: vi.fn(async () => []) },
  subscription: { findFirst: vi.fn(async () => null) },
  plan: {
    findFirst: vi.fn(async () => ({
      id: "plan-free",
      slug: "free",
      status: "PUBLISHED",
      currentVersion: {
        id: "pv-free",
        entitlements: FREE_PLAN_V1_ENTITLEMENTS,
      },
    })),
  },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(async (fn: unknown) =>
    typeof fn === "function"
      ? (fn as (tx: typeof mockDb) => unknown)(mockDb)
      : fn
  ),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import {
  createApiKeyForUser,
  generateApiKey,
  hashApiKey,
  listApiKeysForUser,
  resolveApiKey,
  revokeApiKeyForUser,
  rotateApiKeyForUser,
} from "@sendcms/api-keys"
import { ApiError } from "@sendcms/api-client"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

const userId = "user-1"

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    name: "Claude Desktop",
    scope: "FULL",
    prefix: "sk_live_aB3x",
    last4: "9f2k",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-11-19T00:00:00Z"),
    updatedAt: new Date("2026-11-19T00:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.user.findUnique.mockResolvedValue({
    id: userId,
    emailVerified: true,
  })
  mockDb.apiKey.count.mockResolvedValue(0)
})

describe("generateApiKey / hashApiKey", () => {
  it("generates a sk_live_ key with 256 bits of entropy", () => {
    const key = generateApiKey()
    expect(key.startsWith("sk_live_")).toBe(true)
    expect(key.length).toBe(8 + 43) // prefix + 32 bytes base64url
    expect(generateApiKey()).not.toBe(key)
  })

  it("hashes deterministically to 64 hex chars", () => {
    const key = generateApiKey()
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"))
    expect(hashApiKey(key)).toHaveLength(64)
    expect(hashApiKey(generateApiKey())).not.toBe(hashApiKey(key))
  })
})

describe("createApiKeyForUser", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    mockDb.apiKey.create.mockImplementation(
      async ({ data }: { data: { name: string; scope: "READ" | "FULL" } }) => ({
        ...makeKeyRow({ name: data.name, scope: data.scope }),
      })
    )
    const created = await createApiKeyForUser(userId, {
      name: "Claude Desktop",
      scope: "FULL",
    })
    expect(created.key.startsWith("sk_live_")).toBe(true)
    const createArg = mockDb.apiKey.create.mock.calls[0][0]
    expect(createArg.data.keyHash).toBe(hashApiKey(created.key))
    expect(createArg.data.keyHash).not.toBe(created.key)
    expect(createArg.data.prefix).toBe(created.key.slice(0, 12))
    expect(createArg.data.last4).toBe(created.key.slice(-4))
    expect(createArg.data).not.toHaveProperty("key")
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CREATE",
          resourceType: "API_KEY",
          userId,
        }),
      })
    )
  })

  it("rejects an unknown user and an unverified email", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null)
    await expect(
      createApiKeyForUser(userId, { name: "x", scope: "FULL" })
    ).rejects.toThrowError(ApiError)
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: userId,
      emailVerified: false,
    })
    await expect(
      createApiKeyForUser(userId, { name: "x", scope: "FULL" })
    ).rejects.toThrowError("Verify your email")
  })

  it("caps active keys at ten", async () => {
    mockDb.apiKey.count.mockResolvedValue(10)
    await expect(
      createApiKeyForUser(userId, { name: "x", scope: "READ" })
    ).rejects.toThrowError("at most 10 active API keys")
    expect(mockDb.apiKey.create).not.toHaveBeenCalled()
  })
})

describe("listApiKeysForUser", () => {
  it("never selects the key hash", async () => {
    mockDb.apiKey.findMany.mockResolvedValue([makeKeyRow()])
    const keys = await listApiKeysForUser(userId)
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toHaveProperty("keyHash")
    const select = mockDb.apiKey.findMany.mock.calls[0][0].select
    expect(select).not.toHaveProperty("keyHash")
    expect(select).toHaveProperty("prefix")
  })
})

describe("revokeApiKeyForUser", () => {
  it("revokes an owned active key and audits it", async () => {
    mockDb.apiKey.findFirst.mockResolvedValue(makeKeyRow())
    await revokeApiKeyForUser(userId, "key-1")
    expect(mockDb.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1" },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    )
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DELETE",
          resourceType: "API_KEY",
        }),
      })
    )
  })

  it("404s for another owner's key and 409s when already revoked", async () => {
    mockDb.apiKey.findFirst.mockResolvedValue(null)
    await expect(revokeApiKeyForUser(userId, "key-1")).rejects.toThrowError(
      "API key not found"
    )
    mockDb.apiKey.findFirst.mockResolvedValue(
      makeKeyRow({ revokedAt: new Date() })
    )
    await expect(revokeApiKeyForUser(userId, "key-1")).rejects.toThrowError(
      "already revoked"
    )
  })
})

describe("rotateApiKeyForUser", () => {
  it("revokes the old key and issues a fresh one with the same name and scope", async () => {
    const old = makeKeyRow()
    mockDb.apiKey.findFirst.mockResolvedValue(old)
    mockDb.apiKey.create.mockImplementation(
      async ({ data }: { data: { name: string; scope: "READ" | "FULL" } }) => ({
        ...makeKeyRow({ id: "key-2", name: data.name, scope: data.scope }),
      })
    )
    const rotated = await rotateApiKeyForUser(userId, "key-1")
    expect(rotated.key.startsWith("sk_live_")).toBe(true)
    expect(rotated.name).toBe(old.name)
    expect(rotated.scope).toBe(old.scope)
    expect(mockDb.$transaction).toHaveBeenCalled()
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "UPDATE",
          resourceType: "API_KEY",
          resourceId: "key-1",
          detail: expect.objectContaining({ event: "rotated" }),
        }),
      })
    )
  })

  it("refuses to rotate a revoked key", async () => {
    mockDb.apiKey.findFirst.mockResolvedValue(
      makeKeyRow({ revokedAt: new Date() })
    )
    await expect(rotateApiKeyForUser(userId, "key-1")).rejects.toThrowError(
      "Cannot rotate a revoked API key"
    )
  })
})

describe("resolveApiKey", () => {
  it("resolves an active key and touches lastUsedAt", async () => {
    const key = generateApiKey()
    mockDb.apiKey.findUnique.mockResolvedValue({
      id: "key-1",
      userId,
      scope: "READ",
      revokedAt: null,
    })
    const resolved = await resolveApiKey(key)
    expect(resolved).toEqual({ keyId: "key-1", userId, scope: "READ" })
    expect(mockDb.apiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { keyHash: hashApiKey(key) },
      })
    )
    expect(mockDb.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1" },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    )
  })

  it("returns null for an unknown or revoked key", async () => {
    mockDb.apiKey.findUnique.mockResolvedValue(null)
    expect(await resolveApiKey(generateApiKey())).toBeNull()
    mockDb.apiKey.findUnique.mockResolvedValue({
      id: "key-1",
      userId,
      scope: "FULL",
      revokedAt: new Date(),
    })
    expect(await resolveApiKey(generateApiKey())).toBeNull()
  })
})
