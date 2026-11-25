// Wave 8 Stream D regression tests (SRC-219, SRC-223, SRC-224, DB-035,
// SRC-229, SRC-230, SRC-233, SRC-234, SRC-235, DOC-023, DOC-035/036/037,
// DOC-038, DOC-039, DOC-040, DOC-043).
//
// No test hits the real DB, a real provider, or the network. Provider
// timeouts are exercised through stubbed fetch / the SDK's own HTTP
// client, and the MCP doc checks run the real server over an in-memory
// transport plus the real Streamable HTTP transport for DOC-038.
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Stripe is externalized by Vitest (node_modules), so `vi.mock("stripe")`
// never applies to the SUT's import — same pattern as
// tests/billing-checkout.test.ts: spy on the shared module instance.
const stripeEsm =
  await import("../node_modules/.pnpm/stripe@23.2.0_@types+node@26.6.6/node_modules/stripe/esm/stripe.esm.node.js")
const StripeEsm = stripeEsm.default as new (
  key: string,
  opts?: Record<string, unknown>
) => {
  _api: {
    timeout: number
    httpClient: { makeRequest: (...args: unknown[]) => Promise<unknown> }
  }
}

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
  $executeRaw: vi.fn(async () => []),
  user: { findUnique: vi.fn() },
  plan: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  planVersion: { findUnique: vi.fn() },
  subscription: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  subscriptionEvent: { create: vi.fn() },
  entitlementOverride: { findMany: vi.fn() },
  apiKey: { count: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  mcpSettings: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
  mcpUserSettings: { findUnique: vi.fn() },
}))

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

import { BillingProvider } from "@sendcms/database"
import { BILLING_PROVIDER_IDS } from "@sendcms/billing/registry"
import {
  checkoutSessionSchema,
  setProviderConfigBodySchema,
} from "@sendcms/billing/validators"
import { countryFromHeaders } from "../packages/modules/billing/src/geo"
import {
  BILLING_PROVIDER_TIMEOUT_MS,
  type PlanVersionForCheckout,
} from "../packages/modules/billing/src/providers/types"
import { createPayPalCheckoutSession } from "../packages/modules/billing/src/providers/paypal"
import { createStripeCheckoutSession } from "../packages/modules/billing/src/providers/stripe"
import { createPolarCheckoutSession } from "../packages/modules/billing/src/providers/polar"
import { createApiKeyForUser } from "@sendcms/api-keys"
import { CreateApiKeySchema } from "@sendcms/api-keys/validators"
import { executeMigration, getMigrationPreview } from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"
import type { AdminSession } from "@sendcms/auth"
import { checkMcpAccess, createMcpServer } from "@sendcms/mcp"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpAuthContext } from "@sendcms/mcp"

const repoRoot = process.cwd()
const readDoc = (path: string) => readFileSync(`${repoRoot}/${path}`, "utf8")

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "owner-1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: "owner-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () => makeActor()

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    planId: "plan-1",
    plan: { name: "Free" },
    version: 1,
    status: "PUBLISHED",
    priceAmount: 0,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    changeReason: null,
    publishedAt: new Date("2026-11-01T00:00:00Z"),
    createdById: null,
    entitlements: { ...FREE_PLAN_V1_ENTITLEMENTS },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    userId: "user-1",
    planId: "plan-1",
    planVersionId: "version-1",
    provider: "STRIPE",
    providerSubscriptionId: "sub_ext_1",
    providerCustomerId: null,
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    planVersion: makeVersion(),
    plan: { id: "plan-1", name: "Free", slug: "free" },
    user: { id: "user-1", name: "User One", email: "user1@example.com" },
    ...overrides,
  }
}

const freePlanRow = {
  id: "plan-1",
  name: "Free",
  slug: "free",
  currentVersion: {
    ...makeVersion(),
    plan: { id: "plan-1", name: "Free", slug: "free" },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(mockDb)
  )
})

// ─── SRC-229: new API keys default to READ ────────────────────────────────

describe("SRC-229 — new API keys default to the least-privilege scope", () => {
  it("defaults scope to READ when the caller does not pass one", () => {
    expect(CreateApiKeySchema.parse({ name: "ci" })).toEqual({
      name: "ci",
      scope: "READ",
    })
  })

  it("still accepts an explicit FULL scope", () => {
    expect(CreateApiKeySchema.parse({ name: "ci", scope: "FULL" })).toEqual({
      name: "ci",
      scope: "FULL",
    })
  })
})

// ─── SRC-219: API-key count limit enforced atomically ─────────────────────

describe("SRC-219 — API-key count limit is enforced inside the insert transaction", () => {
  beforeEach(() => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "user-1",
      emailVerified: true,
    })
    mockDb.entitlementOverride.findMany.mockResolvedValue([])
    mockDb.subscription.findFirst.mockResolvedValue(null)
    mockDb.plan.findFirst.mockResolvedValue(freePlanRow)
    mockDb.apiKey.count.mockResolvedValue(0)
    mockDb.apiKey.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "key-1",
        name: data.name,
        scope: data.scope,
        createdAt: new Date(),
      })
    )
  })

  it("counts and creates inside one transaction under a per-user advisory lock", async () => {
    const result = await createApiKeyForUser(
      "user-1",
      CreateApiKeySchema.parse({ name: "ci" })
    )
    expect(result.scope).toBe("READ")
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    // The count + create must happen on the transaction client, not on
    // the shared client — otherwise the pre-insert check races (SRC-219).
    const tx = mockDb.$transaction.mock.calls[0][0]
    expect(typeof tx).toBe("function")
    expect(mockDb.$executeRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = mockDb.$executeRaw.mock
      .calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(strings.join("")).toContain("pg_advisory_xact_lock")
    expect(values).toEqual(["sendcms:create:api-key:user-1"])
    expect(mockDb.apiKey.count).toHaveBeenCalled()
    expect(mockDb.apiKey.create).toHaveBeenCalled()
  })

  it("refuses the 11th key inside the transaction, without creating", async () => {
    mockDb.apiKey.count.mockResolvedValue(10)
    await expect(
      createApiKeyForUser("user-1", CreateApiKeySchema.parse({ name: "extra" }))
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("at most 10 active API keys"),
    })
    expect(mockDb.apiKey.create).not.toHaveBeenCalled()
  })
})

// ─── SRC-223: migration preview counts the full population ───────────────

describe("SRC-223 — getMigrationPreview reports the full affected count", () => {
  const target = makeVersion({
    id: "version-2",
    planId: "plan-2",
    plan: { name: "Pro" },
    version: 2,
    priceAmount: 1999,
    entitlements: { ...FREE_PLAN_V1_ENTITLEMENTS, forms: 10 },
  })

  beforeEach(() => {
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    mockDb.plan.findUniqueOrThrow.mockResolvedValue({
      id: "plan-2",
      name: "Pro",
      slug: "pro",
    })
  })

  it("counts allOnVersionId rows instead of capping at the 100-row window", async () => {
    const window = [
      makeSubscription(),
      makeSubscription({
        id: "sub-2",
        userId: "user-2",
        user: { id: "user-2", name: "User Two", email: "user2@example.com" },
      }),
    ]
    mockDb.subscription.findMany.mockResolvedValue(window)
    mockDb.subscription.count.mockResolvedValue(150)
    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      allOnVersionId: "version-1",
    })
    expect(preview.affectedCount).toBe(150)
    expect(preview.previewTruncated).toBe(true)
    expect(preview.users).toHaveLength(2)
    expect(mockDb.subscription.count).toHaveBeenCalledWith({
      where: {
        planVersionId: "version-1",
        status: { in: ["ACTIVE", "TRIALING"] },
      },
    })
  })

  it("reports 0 and does not count when source and target are the same version", async () => {
    mockDb.subscription.findMany.mockResolvedValue([])
    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      allOnVersionId: "version-2",
    })
    expect(preview.affectedCount).toBe(0)
    expect(preview.previewTruncated).toBe(false)
    expect(mockDb.subscription.count).not.toHaveBeenCalled()
  })
})

// ─── SRC-224 + DB-035: migration executes per user, survives failure ─────

describe("SRC-224 / DB-035 — executeMigration is partial-failure safe and race safe", () => {
  const target = makeVersion({
    id: "version-2",
    planId: "plan-2",
    plan: { name: "Pro" },
    version: 2,
    priceAmount: 1999,
  })

  beforeEach(() => {
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    mockDb.subscriptionEvent.create.mockResolvedValue({})
    mockLogAudit.mockResolvedValue(undefined)
  })

  function threeUserSetup() {
    const subs: Record<string, ReturnType<typeof makeSubscription>> = {
      "user-1": makeSubscription(),
      "user-2": makeSubscription({
        id: "sub-2",
        userId: "user-2",
        user: { id: "user-2", name: "User Two", email: "user2@example.com" },
      }),
      "user-3": makeSubscription({
        id: "sub-3",
        userId: "user-3",
        user: { id: "user-3", name: "User Three", email: "user3@example.com" },
      }),
    }
    mockDb.subscription.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string } }) => subs[where.userId]
    )
    mockDb.subscription.updateMany.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        if (where.id === "sub-2") throw new Error("database unavailable")
        return { count: 1 }
      }
    )
  }

  it("migrates the other users when one user's transaction fails, and audits the failure", async () => {
    threeUserSetup()
    const result = await executeMigration(ownerActor(), {
      planVersionId: "version-2",
      reason: "Wave 8 SRC-224 partial-failure test",
      userIds: ["user-1", "user-2", "user-3"],
    })
    expect(result.migratedUserIds).toEqual(["user-1", "user-3"])
    expect(result.failedUserIds).toEqual(["user-2"])
    expect(result.skippedUserIds).toEqual([])
    expect(result.count).toBe(2)
    // The audit row is written even on partial failure (SRC-224).
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MIGRATE",
        detail: expect.objectContaining({
          failedCount: 1,
          failedUserIds: ["user-2"],
        }),
      })
    )
    // user-3 was still attempted after user-2 failed.
    expect(mockDb.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "sub-3" }),
      })
    )
  })

  it("DB-035: skips a user whose subscription moved to another version before the write", async () => {
    const current = makeSubscription()
    const moved = makeSubscription({
      planVersionId: "version-3",
      planVersion: makeVersion({ id: "version-3", name: "Pro v3" }),
    })
    mockDb.subscription.findFirst
      .mockResolvedValueOnce(current) // pre-read: on version-1
      .mockResolvedValueOnce(moved) // in-tx re-read: already on version-3
    const result = await executeMigration(ownerActor(), {
      planVersionId: "version-2",
      reason: "Wave 8 DB-035 moved-version skip test",
      userIds: ["user-1"],
    })
    expect(result.migratedUserIds).toEqual([])
    expect(result.skippedUserIds).toEqual(["user-1"])
    expect(result.failedUserIds).toEqual([])
    // No conditional write and no MIGRATED event for the skipped user.
    expect(mockDb.subscription.updateMany).not.toHaveBeenCalled()
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })

  it("DB-035: treats a conditional write that matches 0 rows as a skip", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(makeSubscription())
    mockDb.subscription.updateMany.mockResolvedValue({ count: 0 })
    const result = await executeMigration(ownerActor(), {
      planVersionId: "version-2",
      reason: "Wave 8 DB-035 count-0 skip test",
      userIds: ["user-1"],
    })
    expect(result.migratedUserIds).toEqual([])
    expect(result.skippedUserIds).toEqual(["user-1"])
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })
})

// ─── SRC-230: billing validators no longer import the Prisma enum ────────

describe("SRC-230 — billing validators are runtime-free of @sendcms/database", () => {
  const validatorsSource = readDoc("packages/modules/billing/src/validators.ts")

  it("does not import @sendcms/database at runtime", () => {
    // No import of the database package, and no z.nativeEnum() call —
    // the word "nativeEnum" still appears in the SRC-230 comment
    // explaining the removal, so match the call form, not the word.
    expect(validatorsSource).not.toMatch(/from\s+["']@sendcms\/database["']/)
    expect(validatorsSource).not.toMatch(/z\.nativeEnum\s*\(/)
  })

  it("accepts all five providers and rejects unknown ones", () => {
    for (const provider of [
      "STRIPE",
      "PAYPAL",
      "POLAR",
      "FREEMIUS",
      "GUMROAD",
    ]) {
      expect(
        setProviderConfigBodySchema.parse({ provider, reason: "x" }).provider
      ).toBe(provider)
      expect(
        checkoutSessionSchema.parse({ planVersionId: "pv-1", provider })
          .provider
      ).toBe(provider)
    }
    expect(() =>
      setProviderConfigBodySchema.parse({ provider: "BITCOIN", reason: "x" })
    ).toThrow()
    expect(() =>
      checkoutSessionSchema.parse({
        planVersionId: "pv-1",
        provider: "BITCOIN",
      })
    ).toThrow()
  })

  it("drift guard: the validator set equals the registry and the Prisma enum", () => {
    const fromValidators = ["STRIPE", "PAYPAL", "POLAR", "FREEMIUS", "GUMROAD"]
    expect([...BILLING_PROVIDER_IDS].sort()).toEqual([...fromValidators].sort())
    expect(Object.values(BillingProvider).sort()).toEqual(
      [...fromValidators].sort()
    )
  })
})

// ─── SRC-233: provider HTTP calls have a timeout ─────────────────────────

const checkoutVersion: PlanVersionForCheckout = {
  id: "pv-1",
  planId: "plan-1",
  planName: "Pro",
  priceAmount: 9900,
  priceCurrency: "USD",
  billingInterval: "MONTHLY",
  trialDays: 0,
}

const checkoutArgs = {
  version: checkoutVersion,
  customer: { userId: "user-1", email: "user@example.com", name: "User" },
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "attempt-123",
}

describe("SRC-233 — provider HTTP calls time out instead of hanging forever", () => {
  it("shares one 30 s timeout constant across providers", () => {
    expect(BILLING_PROVIDER_TIMEOUT_MS).toBe(30_000)
  })

  // Node's AbortSignal.timeout runs on an internal timer that Vitest's
  // fake timers do not drive, so the timeout is proven by spying on
  // AbortSignal.timeout itself: the SUT must ask for exactly the shared
  // constant, and the returned signal is a real short one so the test
  // finishes in milliseconds instead of 30 s.
  const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal)

  function shortTimeoutSpy() {
    const requestedMs: number[] = []
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => {
        requestedMs.push(ms)
        return realAbortTimeout(50)
      })
    return { spy, requestedMs }
  }

  it("PayPal: a hung endpoint aborts at the timeout and surfaces a 502", async () => {
    process.env.PAYPAL_CLIENT_ID = "id"
    process.env.PAYPAL_CLIENT_SECRET = "secret"
    delete process.env.PAYPAL_MODE
    const { spy, requestedMs } = shortTimeoutSpy()
    const seenSignals: (AbortSignal | null | undefined)[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/oauth2/token")) {
        return { ok: true, json: async () => ({ access_token: "tok" }) }
      }
      seenSignals.push(init?.signal ?? null)
      // Hang forever, but honour the abort signal like a real fetch does.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError"))
        )
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(
        createPayPalCheckoutSession(checkoutArgs)
      ).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining("payment provider is unavailable"),
      })
      // Every PayPal fetch (token + the hung call) carries a timeout
      // signal built from the shared 30 s constant.
      expect(requestedMs.length).toBeGreaterThanOrEqual(1)
      expect(
        requestedMs.every((ms) => ms === BILLING_PROVIDER_TIMEOUT_MS)
      ).toBe(true)
      expect(seenSignals).toHaveLength(1)
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
      expect(seenSignals[0]?.aborted).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      spy.mockRestore()
      delete process.env.PAYPAL_CLIENT_ID
      delete process.env.PAYPAL_CLIENT_SECRET
    }
  })

  it("Stripe: the client the service builds carries the 30 s timeout", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x"
    const probe = new StripeEsm("sk_test_probe")
    const makeRequestSpy = vi.fn(async () => ({
      getStatusCode: () => 200,
      getHeaders: () => ({}),
      // toJSON must return a promise and getRawResponse a mutable
      // object — the SDK calls .then() on the former and stamps
      // headers/statusCode onto the latter.
      getRawResponse: () => ({}),
      toJSON: () =>
        Promise.resolve({
          id: "price_1",
          url: "https://checkout.stripe.test/pay",
        }),
    }))
    const spy = vi
      .spyOn(
        Object.getPrototypeOf(probe._api.httpClient) as {
          makeRequest: (...args: unknown[]) => Promise<unknown>
        },
        "makeRequest"
      )
      .mockImplementation(makeRequestSpy as never)
    try {
      const result = await createStripeCheckoutSession(checkoutArgs)
      expect(result.checkoutUrl).toBe("https://checkout.stripe.test/pay")
      expect(makeRequestSpy).toHaveBeenCalled()
      // makeRequest(host, port, path, method, headers, data, protocol, timeout)
      expect(makeRequestSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        BILLING_PROVIDER_TIMEOUT_MS
      )
    } finally {
      spy.mockRestore()
      delete process.env.STRIPE_SECRET_KEY
    }
  })

  it("Polar: a hung endpoint aborts at the timeout", async () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_test_token"
    const { spy, requestedMs } = shortTimeoutSpy()
    const seenSignals: (AbortSignal | null | undefined)[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? null)
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError"))
        )
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(createPolarCheckoutSession(checkoutArgs)).rejects.toThrow()
      expect(requestedMs).toContain(BILLING_PROVIDER_TIMEOUT_MS)
      expect(seenSignals.length).toBeGreaterThanOrEqual(1)
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
      expect(seenSignals[0]?.aborted).toBe(true)
    } finally {
      vi.unstubAllGlobals()
      spy.mockRestore()
      delete process.env.POLAR_ACCESS_TOKEN
    }
  })
})

// ─── SRC-234: geo detection treats Vercel XX/T1 as unknown ──────────────

describe("SRC-234 — geo detection never returns Vercel XX/T1 as a country", () => {
  const vercel = (country: string) =>
    new Headers({ "x-vercel-ip-country": country })
  const cloudflare = (country: string) =>
    new Headers({ "cf-ipcountry": country })

  it("maps Vercel XX and T1 to null", () => {
    expect(countryFromHeaders(vercel("XX"))).toBeNull()
    expect(countryFromHeaders(vercel("T1"))).toBeNull()
  })

  it("still maps a real Vercel country, normalising case and whitespace", () => {
    expect(countryFromHeaders(vercel(" us "))).toBe("US")
    expect(countryFromHeaders(vercel("de"))).toBe("DE")
  })

  it("maps Cloudflare XX to null and a real Cloudflare country through", () => {
    expect(countryFromHeaders(cloudflare("XX"))).toBeNull()
    expect(countryFromHeaders(cloudflare("GB"))).toBe("GB")
  })

  it("returns null when no geo headers are present", () => {
    expect(countryFromHeaders(new Headers())).toBeNull()
  })
})

// ─── SRC-235 + DOC-023: reads that mutate are gone; flags are seeded ────

describe("SRC-235 / DOC-023 — reads are pure; platform settings are seeded", () => {
  it("the migration seeds the MCP singleton, all five AI providers, and both AI flags", () => {
    const sql = readDoc(
      "packages/database/prisma/migrations/20261125091400_wave8d_seed_platform_settings/migration.sql"
    )
    expect(sql).toContain("'platform'")
    for (const provider of [
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "openrouter",
    ]) {
      expect(sql).toContain(`seed-ai-provider-${provider}`)
    }
    expect(sql).toContain("ai-spam-rescore")
    expect(sql).toContain("ai-digest")
    expect(sql).toContain("ON CONFLICT DO NOTHING")
  })

  it("the docs tell a fresh deploy both AI flags exist seeded-disabled", () => {
    const deployment = readDoc("docs/deployment.md")
    expect(deployment).toContain("ai-spam-rescore")
    expect(deployment).toContain("ai-digest")
    expect(deployment).toContain("seeded")
    const runbook = readDoc("docs/operations/runbook.md")
    expect(runbook).toContain("ai-spam-rescore")
    expect(runbook).toContain("ai-digest")
    const platformOps = readDoc(
      "docs/admin-control-plane/platform-operations.md"
    )
    expect(platformOps).not.toContain("There are NO seed flags")
    expect(platformOps).toContain("ai-spam-rescore")
  })
})

// ─── DOC-035/036/037/043: docs/mcp.md Tools table matches the code ──────

const fullAuth: McpAuthContext = {
  keyId: "key-1",
  userId: "user-1",
  scope: "FULL",
}
const readAuth: McpAuthContext = {
  keyId: "key-2",
  userId: "user-1",
  scope: "READ",
}

async function connectClient(auth: McpAuthContext) {
  const server = createMcpServer(auth)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: "wave8d-client", version: "1.0.0" },
    { capabilities: {} }
  )
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

function parseToolsTable(doc: string) {
  const rows = new Map<string, { scope: string; description: string }>()
  for (const line of doc.split("\n")) {
    const match = line.match(
      /^\|\s*`([a-z_]+)`\s*\|\s*(READ|FULL)\s*\|\s*(.+?)\s*\|$/
    )
    if (match) {
      rows.set(match[1], { scope: match[2], description: match[3].trim() })
    }
  }
  return rows
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim()

describe("DOC-035/036/037/043 — docs/mcp.md Tools table matches the registered tools", () => {
  it("every registered tool has a row, and every row's description is the registered description verbatim", async () => {
    const { client, server } = await connectClient(fullAuth)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(19)
      const rows = parseToolsTable(readDoc("docs/mcp.md"))
      expect([...rows.keys()].sort()).toEqual(tools.map((t) => t.name).sort())
      for (const tool of tools) {
        const row = rows.get(tool.name)
        expect(row).toBeDefined()
        // create_form appends one linking sentence after the verbatim
        // description (DOC-037); every other row is verbatim.
        if (tool.name === "create_form") {
          expect(normalise(row!.description)).toContain(
            normalise(tool.description ?? "")
          )
          expect(row!.description).toContain(
            "Link a verified domain from the dashboard before it can accept submissions."
          )
        } else {
          expect(normalise(row!.description)).toBe(
            normalise(tool.description ?? "")
          )
        }
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("the corrected rows say what the code does (DOC-035/036/043)", async () => {
    const rows = parseToolsTable(readDoc("docs/mcp.md"))
    // DOC-035: delete_domain is refused while forms are linked.
    expect(rows.get("delete_domain")!.description).toContain(
      "Refused while any form is still linked to it"
    )
    // DOC-036: update_form takes no `fields` parameter — the old doc
    // said "name, fields, or settings". (The registered description
    // itself says "the fields you pass change", which is about the
    // named fields, not a fields parameter.)
    expect(rows.get("update_form")!.description).not.toContain(
      "name, fields, or settings"
    )
    // DOC-043: delete_form keeps submissions; update_submission
    // restores before other actions; list_submissions is 20 per page.
    expect(rows.get("delete_form")!.description).toContain(
      "Its submissions are kept"
    )
    expect(rows.get("update_submission")!.description).toContain(
      "Archived and spam submissions must be restored before any other action"
    )
    expect(rows.get("list_submissions")!.description).toContain("20 per page")
  })
})

// ─── DOC-038: a READ key calling a FULL tool gets an MCP error, not HTTP 40x ─

describe("DOC-038 — READ key calling a FULL tool over HTTP", () => {
  // Mirrors apps/api/app/api/mcp/route.ts runMcpRequest: a fresh server
  // and a fresh stateless transport per request (the transport cannot
  // be reused across requests), JSON response mode.
  async function postJsonRpc(
    auth: McpAuthContext,
    body: Record<string, unknown>
  ) {
    const server = createMcpServer(auth)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Both types are required by the transport (Accept without
        // text/event-stream is a 406); enableJsonResponse: true above
        // is what makes the answer a plain JSON body instead of SSE.
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    })
    const res = await transport.handleRequest(req, { parsedBody: body })
    const json = await res.json()
    await server.close()
    return { status: res.status, json }
  }

  it("returns HTTP 200 with an MCP -32602 tool error, and tools/list omits FULL tools", async () => {
    const call = await postJsonRpc(readAuth, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_domain",
        arguments: { domain: "example.com" },
      },
    })
    expect(call.status).toBe(200)
    const result = (
      call.json as { result: { isError: boolean; content: { text: string }[] } }
    ).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      "MCP error -32602: Tool create_domain not found"
    )

    const { client, server: listServer } = await connectClient(readAuth)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(9)
      expect(tools.map((t) => t.name)).not.toContain("create_domain")
    } finally {
      await client.close()
      await listServer.close()
    }
  })

  it("the HTTP 404 is the admin-allowlist path, not the READ-key path", async () => {
    mockDb.mcpSettings.findUnique.mockResolvedValue(null)
    mockDb.user.findUnique.mockResolvedValue({ status: "ACTIVE" })
    mockDb.mcpUserSettings.findUnique.mockResolvedValue({
      isEnabled: true,
      allowedTools: ["list_domains"],
    })
    await expect(
      checkMcpAccess({
        auth: { keyId: "key-1", userId: "user-1", scope: "FULL" },
        tool: "create_domain",
      })
    ).rejects.toMatchObject({
      status: 404,
      message: "Tool create_domain not found",
    })
  })
})

// ─── DOC-039/040: Errors table and rate limits in docs/mcp.md ───────────

describe("DOC-039/040 — docs/mcp.md Errors table and rate limits", () => {
  it("the Errors table lists 403, 404 and 503 with the code's meanings", () => {
    const doc = readDoc("docs/mcp.md")
    expect(doc).toContain("Suspended account, or MCP disabled for this account")
    expect(doc).toContain("admin-set allowlist")
    expect(doc).toContain("kill-switch")
    // And the READ-key / FULL-tool case is explicitly NOT a 40x row.
    expect(doc).toContain("is NOT one of these rows")
  })

  it("rate limits are presented as overridable defaults, not fixed per-key numbers", async () => {
    const doc = readDoc("docs/mcp.md")
    expect(doc).toContain("admin per-user override")
    expect(doc).toContain("plan's entitlements")
    expect(doc).toContain("effective limit resolves as")
    expect(doc).not.toContain("Per key: **120 requests/minute**")
    const { MCP_MINUTE_LIMIT, MCP_HOUR_LIMIT } =
      await import("../packages/mcp/src/rate-limit")
    expect(MCP_MINUTE_LIMIT).toBe(120)
    expect(MCP_HOUR_LIMIT).toBe(2000)
  })
})
