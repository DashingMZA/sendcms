// MCP admin controls (Admin Control Plane, Phase 6) with a mocked
// Prisma client, a mocked plans entitlements lookup, and a mocked
// api-keys revoke. The real @sendcms/mcp access check, rate limiter,
// tool registration filter, usage recorder, and the real
// @sendcms/mcp-admin service run — only the database, the plans
// lookup, the revoke call, and the audit writer are stubbed. No test
// hits the real DB or a real MCP client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AdminSession } from "@sendcms/auth"
import type { EffectiveEntitlements } from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"

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
const plainSession = makeSession({
  id: "user-9",
  email: "plain@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: null,
})

const mockLogAudit = vi.hoisted(() =>
  vi.fn(async (call: { detail?: Record<string, unknown> }) => call)
)
// Phase 9: the gated actions (kill-switch toggle, key revoke) call
// requireStepUp. This file replaces @sendcms/security wholesale, so
// the gate is stubbed to pass — the real gate is covered by
// tests/step-up.test.ts.
const mockRequireStepUp = vi.hoisted(() =>
  vi.fn(async () => ({ verifiedUntil: new Date("2099-01-01T00:00:00.000Z") }))
)
const mockGetEffective = vi.hoisted(() => vi.fn())
const mockRevokeApiKey = vi.hoisted(() => vi.fn(async () => undefined))

// A stateful in-memory fake DB. Prisma `select`/`include` args are
// ignored — the code only reads the fields it needs. `update`/`upsert`
// skip `undefined` values, like Prisma does. The `allowedTools` Json
// column normalizes any non-array object (Prisma.JsonNull) to null,
// which is how Prisma surfaces a cleared Json field on read.
const { store, mockDb } = vi.hoisted(() => {
  type StoredUser = {
    id: string
    name: string | null
    email: string
    status: string
  }
  type StoredKey = {
    id: string
    name: string
    scope: string
    prefix: string
    last4: string
    userId: string
    lastUsedAt: Date | null
    revokedAt: Date | null
    createdAt: Date
  }
  type StoredUserSettings = {
    userId: string
    isEnabled: boolean
    allowedTools: string[] | null
    minuteLimit: number | null
    hourLimit: number | null
  }
  type StoredUsage = {
    id: string
    apiKeyId: string
    userId: string
    tool: string
    status: string
    durationMs: number | null
    createdAt: Date
  }
  type StoredRateLimit = {
    apiKeyId: string
    minuteWindowStart: Date
    minuteCount: number
    hourWindowStart: Date
    hourCount: number
  }

  const store = {
    users: new Map<string, StoredUser>(),
    keys: new Map<string, StoredKey>(),
    globalSettings: null as { globalEnabled: boolean } | null,
    userSettings: new Map<string, StoredUserSettings>(),
    usage: [] as StoredUsage[],
    rateLimits: new Map<string, StoredRateLimit>(),
    usageSeq: 1,
  }

  function applyData(
    row: Record<string, unknown>,
    data: Record<string, unknown>
  ): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue
      if (k === "allowedTools") {
        // Array = the allowlist; null = cleared; any other object
        // (Prisma.JsonNull) = cleared on read.
        row[k] = Array.isArray(v) ? v : v === null ? null : null
        continue
      }
      row[k] = v
    }
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

  function groupUsage(
    by: string[],
    where: Record<string, unknown> | undefined,
    orderByCountDesc: boolean,
    take?: number
  ) {
    const rows = store.usage.filter((r) => matchesUsageWhere(r, where))
    const groups = new Map<string, Record<string, unknown>>()
    for (const r of rows) {
      const key = by
        .map((f) => String((r as unknown as Record<string, unknown>)[f] ?? ""))
        .join("|")
      let g = groups.get(key)
      if (!g) {
        g = { _count: { _all: 0 } }
        for (const f of by) {
          g[f] = (r as unknown as Record<string, unknown>)[f]
        }
        groups.set(key, g)
      }
      ;(g._count as { _all: number })._all += 1
    }
    const out = [...groups.values()]
    if (orderByCountDesc) {
      out.sort(
        (a, b) =>
          (b._count as { _all: number })._all -
          (a._count as { _all: number })._all
      )
    }
    return take === undefined ? out : out.slice(0, take)
  }

  const mockDb = {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.users.get(where.id) ?? null
      ),
      findMany: vi.fn(
        async ({ where }: { where?: { id?: { in?: string[] } } }) => {
          const ids = where?.id?.in
          return [...store.users.values()].filter(
            (u) => !ids || ids.includes(u.id)
          )
        }
      ),
    },
    mcpSettings: {
      findFirst: vi.fn(async () => store.globalSettings),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          if (store.globalSettings) {
            applyData(
              store.globalSettings as unknown as Record<string, unknown>,
              update
            )
            return store.globalSettings
          }
          const row = {
            globalEnabled:
              (create.globalEnabled as boolean | undefined) ?? true,
          }
          store.globalSettings = row
          return row
        }
      ),
    },
    mcpUserSettings: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) =>
          store.userSettings.get(where.userId) ?? null
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
          const existing = store.userSettings.get(where.userId)
          if (existing) {
            applyData(existing as unknown as Record<string, unknown>, update)
            return existing
          }
          const row: StoredUserSettings = {
            userId: where.userId,
            isEnabled: true,
            allowedTools: null,
            minuteLimit: null,
            hourLimit: null,
          }
          applyData(row as unknown as Record<string, unknown>, create)
          store.userSettings.set(where.userId, row)
          return row
        }
      ),
    },
    mcpUsageRecord: {
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
          orderBy,
          skip = 0,
          take,
        }: {
          where?: Record<string, unknown>
          include?: { user?: unknown; apiKey?: unknown }
          orderBy?: { createdAt?: string }
          skip?: number
          take?: number
        }) => {
          let rows = store.usage.filter((r) => matchesUsageWhere(r, where))
          if (orderBy?.createdAt === "desc") {
            rows = [...rows].sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
            )
          }
          const page = rows.slice(
            skip,
            take === undefined ? undefined : skip + take
          )
          return page.map((r) => {
            const out: Record<string, unknown> = { ...r }
            if (include?.user) {
              const user = store.users.get(r.userId)
              out.user = user
                ? { id: user.id, name: user.name, email: user.email }
                : null
            }
            if (include?.apiKey) {
              const key = store.keys.get(r.apiKeyId)
              out.apiKey = key
                ? { id: key.id, name: key.name, scope: key.scope }
                : null
            }
            return out
          })
        }
      ),
      groupBy: vi.fn(
        async ({
          by,
          where,
          orderBy,
          take,
        }: {
          by: string[]
          where?: Record<string, unknown>
          orderBy?: { _count?: { _all?: string } }
          take?: number
        }) => groupUsage(by, where, orderBy?._count?._all === "desc", take)
      ),
    },
    apiKey: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.keys.get(where.id) ?? null
      ),
      findMany: vi.fn(
        async ({
          select,
          include,
          orderBy,
          skip = 0,
          take,
        }: {
          select?: { user?: unknown }
          include?: { user?: unknown }
          orderBy?: { createdAt?: string }
          skip?: number
          take?: number
        }) => {
          let rows = [...store.keys.values()]
          if (orderBy?.createdAt === "desc") {
            rows = rows.sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
            )
          }
          const page = rows.slice(
            skip,
            take === undefined ? undefined : skip + take
          )
          return page.map((r) => {
            const out: Record<string, unknown> = { ...r }
            // The service selects the owner (select.user), not
            // include — both shapes attach it here.
            if (include?.user || select?.user) {
              const user = store.users.get(r.userId)
              out.user = user
                ? { id: user.id, name: user.name, email: user.email }
                : null
            }
            return out
          })
        }
      ),
      count: vi.fn(async () => store.keys.size),
    },
    apiKeyRateLimit: {
      findUnique: vi.fn(
        async ({ where }: { where: { apiKeyId: string } }) =>
          store.rateLimits.get(where.apiKeyId) ?? null
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { apiKeyId: string }
          create: Record<string, unknown>
          update: Record<string, unknown>
        }) => {
          const existing = store.rateLimits.get(where.apiKeyId)
          if (existing) {
            applyData(existing as unknown as Record<string, unknown>, update)
            return existing
          }
          const row = create as unknown as StoredRateLimit
          store.rateLimits.set(where.apiKeyId, row)
          return row
        }
      ),
    },
    // Minimal stubs for the MCP tool modules (registration only —
    // no tool is executed in this file).
    domain: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    form: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    submission: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  }

  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({
  logAudit: mockLogAudit,
  requireStepUp: mockRequireStepUp,
}))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, getEffectiveEntitlementsSafe: mockGetEffective }
})
vi.mock("@sendcms/api-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/api-keys")>()
  return { ...actual, revokeApiKeyForUser: mockRevokeApiKey }
})

import {
  checkMcpAccess,
  checkMcpRateLimit,
  createMcpServer,
  extractMcpCallOutcomes,
  recordMcpCallOutcomes,
  recordMcpUsage,
} from "@sendcms/mcp"
import type { McpAuthContext } from "@sendcms/mcp"
import {
  getMcpSettings,
  getMcpUsageSummary,
  getUserMcpSettings,
  listMcpKeys,
  listMcpUsage,
  revokeMcpKey,
  setMcpSettings,
  setUserMcpSettings,
} from "@sendcms/mcp-admin"
import {
  McpPaginationQuerySchema,
  McpUsageListQuerySchema,
  McpUsageSummaryQuerySchema,
  RevokeMcpKeySchema,
  SetMcpSettingsSchema,
  SetUserMcpSettingsSchema,
} from "@sendcms/mcp-admin/validators"
import { ApiError } from "@sendcms/shared"

const fullAuth: McpAuthContext = {
  keyId: "key-1",
  userId: "user-1",
  scope: "FULL",
}
const readAuth: McpAuthContext = {
  keyId: "key-2",
  userId: "user-2",
  scope: "READ",
}

function seedUser(id: string, status = "ACTIVE") {
  store.users.set(id, {
    id,
    name: id === "user-1" ? "Owner One" : "Reader Two",
    email: `${id}@example.com`,
    status,
  })
}

function seedKey(
  id: string,
  userId: string,
  scope: string,
  createdAt = new Date()
) {
  store.keys.set(id, {
    id,
    name: `Key ${id}`,
    scope,
    prefix: "scms_live",
    last4: id.slice(-4),
    userId,
    lastUsedAt: null,
    revokedAt: null,
    createdAt,
  })
}

function seedUsage(
  apiKeyId: string,
  userId: string,
  tool: string,
  status: "SUCCESS" | "FAILED",
  createdAt = new Date()
) {
  store.usage.push({
    id: `usage-${store.usageSeq++}`,
    apiKeyId,
    userId,
    tool,
    status,
    durationMs: 12,
    createdAt,
  })
}

let connected: {
  client: Client
  server: ReturnType<typeof createMcpServer>
} | null = null

async function connectClient(auth: McpAuthContext) {
  const server = createMcpServer(auth)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  )
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  connected = { client, server }
  return client
}

afterEach(async () => {
  if (connected) {
    await connected.client.close().catch(() => {})
    await connected.server.close().catch(() => {})
    connected = null
  }
})

beforeEach(() => {
  store.users.clear()
  store.keys.clear()
  store.globalSettings = null
  store.userSettings.clear()
  store.usage = []
  store.rateLimits.clear()
  store.usageSeq = 1
  vi.clearAllMocks()
  mockGetEffective.mockResolvedValue(freeEntitlements())
  mockRevokeApiKey.mockResolvedValue(undefined)
  seedUser("user-1")
  seedUser("user-2")
  seedKey("key-1", "user-1", "FULL")
  seedKey("key-2", "user-2", "READ")
})

// ─── Enforcement: checkMcpAccess ──────────────────────────────────────

describe("checkMcpAccess — global kill-switch", () => {
  it("refuses every tool call with 503 when the kill-switch is off", async () => {
    store.globalSettings = { globalEnabled: false }
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "list_domains" })
    ).rejects.toMatchObject({
      status: 503,
      message: "MCP is temporarily disabled by the platform administrator.",
    })
  })

  it("refuses tools/list too when the kill-switch is off", async () => {
    store.globalSettings = { globalEnabled: false }
    await expect(checkMcpAccess({ auth: fullAuth })).rejects.toMatchObject({
      status: 503,
    })
  })

  it("passes when no settings row exists yet (enabled by default)", async () => {
    await expect(checkMcpAccess({ auth: fullAuth })).resolves.toEqual({
      allowedTools: null,
      minuteLimit: null,
      hourLimit: null,
    })
  })

  it("passes when the kill-switch is on", async () => {
    store.globalSettings = { globalEnabled: true }
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "list_domains" })
    ).resolves.toEqual({
      allowedTools: null,
      minuteLimit: null,
      hourLimit: null,
    })
  })
})

describe("checkMcpAccess — user status and per-user controls", () => {
  it("refuses a suspended user's key even though the key is valid", async () => {
    store.users.set("user-1", {
      id: "user-1",
      name: "Owner One",
      email: "user-1@example.com",
      status: "SUSPENDED",
    })
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "list_domains" })
    ).rejects.toMatchObject({
      status: 403,
      message: "This account is suspended. MCP access is disabled.",
    })
  })

  it("refuses a disabled user's key", async () => {
    store.users.set("user-1", {
      id: "user-1",
      name: "Owner One",
      email: "user-1@example.com",
      status: "DISABLED",
    })
    await expect(checkMcpAccess({ auth: fullAuth })).rejects.toMatchObject({
      status: 403,
    })
  })

  it("refuses when MCP is disabled for the account", async () => {
    store.userSettings.set("user-1", {
      userId: "user-1",
      isEnabled: false,
      allowedTools: null,
      minuteLimit: null,
      hourLimit: null,
    })
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "list_domains" })
    ).rejects.toMatchObject({
      status: 403,
      message:
        "MCP is disabled for this account by the platform administrator.",
    })
  })

  it("refuses a tool outside the allowlist with 404, never naming the list", async () => {
    store.userSettings.set("user-1", {
      userId: "user-1",
      isEnabled: true,
      allowedTools: ["list_domains"],
      minuteLimit: null,
      hourLimit: null,
    })
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "create_domain" })
    ).rejects.toMatchObject({
      status: 404,
      message: "Tool create_domain not found",
    })
  })

  it("allows a tool inside the allowlist and returns it", async () => {
    store.userSettings.set("user-1", {
      userId: "user-1",
      isEnabled: true,
      allowedTools: ["list_domains", "get_domain"],
      minuteLimit: null,
      hourLimit: null,
    })
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "get_domain" })
    ).resolves.toEqual({
      allowedTools: ["list_domains", "get_domain"],
      minuteLimit: null,
      hourLimit: null,
    })
  })

  it("returns the per-user quota overrides for the rate limiter", async () => {
    store.userSettings.set("user-1", {
      userId: "user-1",
      isEnabled: true,
      allowedTools: null,
      minuteLimit: 5,
      hourLimit: 50,
    })
    await expect(checkMcpAccess({ auth: fullAuth })).resolves.toEqual({
      allowedTools: null,
      minuteLimit: 5,
      hourLimit: 50,
    })
  })
})

// ─── Enforcement: quota precedence ────────────────────────────────────

describe("checkMcpRateLimit — quota precedence", () => {
  async function callWithAccess(auth: McpAuthContext) {
    const access = await checkMcpAccess({ auth })
    await checkMcpRateLimit(auth.keyId, {
      minuteLimit: access.minuteLimit,
      hourLimit: access.hourLimit,
    })
  }

  it("honours a per-user override over the plan entitlements", async () => {
    mockGetEffective.mockResolvedValue(
      entitlementsWith({ mcpRequestsPerMinute: 1 })
    )
    store.userSettings.set("user-1", {
      userId: "user-1",
      isEnabled: true,
      allowedTools: null,
      minuteLimit: 2,
      hourLimit: null,
    })
    await callWithAccess(fullAuth)
    await callWithAccess(fullAuth)
    await expect(callWithAccess(fullAuth)).rejects.toMatchObject({
      status: 429,
    })
  })

  it("honours the plan entitlement when no override is set", async () => {
    mockGetEffective.mockResolvedValue(
      entitlementsWith({ mcpRequestsPerMinute: 1 })
    )
    await callWithAccess(fullAuth)
    await expect(callWithAccess(fullAuth)).rejects.toMatchObject({
      status: 429,
    })
  })

  it("falls back to the platform defaults when the plan has no limits", async () => {
    mockGetEffective.mockResolvedValue(
      entitlementsWith({
        mcpRequestsPerMinute: null,
        mcpRequestsPerHour: null,
      })
    )
    for (let i = 0; i < 120; i++) await callWithAccess(fullAuth)
    await expect(callWithAccess(fullAuth)).rejects.toMatchObject({
      status: 429,
    })
  })

  it("fails open to the defaults when the entitlements lookup throws", async () => {
    mockGetEffective.mockRejectedValue(new Error("plans down"))
    await callWithAccess(fullAuth)
  })
})

// ─── Enforcement: tool registration ───────────────────────────────────

describe("tool registration respects the allowlist", () => {
  it("registers only the allowlisted tools", async () => {
    const client = await connectClient({
      ...fullAuth,
      allowedTools: ["list_domains"],
    })
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(["list_domains"])
  })

  it("registers nothing when the allowlist is empty", async () => {
    const client = await connectClient({ ...fullAuth, allowedTools: [] })
    // With zero tools registered the SDK does not serve tools/list at
    // all — the client gets "Method not found", which is the
    // observable proof that nothing is registered.
    await expect(client.listTools()).rejects.toThrow("Method not found")
  })

  it("intersects the allowlist with the READ scope", async () => {
    const client = await connectClient({
      ...readAuth,
      allowedTools: ["create_domain", "list_domains"],
    })
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(["list_domains"])
  })
})

// ─── Usage recording ──────────────────────────────────────────────────

describe("usage recording", () => {
  const requestBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_domains", arguments: { page: 1 } },
  }
  const responseBody = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "{}" }] },
  }

  it("records exactly one row per executed call, with no arguments", async () => {
    await recordMcpCallOutcomes(fullAuth, requestBody, responseBody, 42)
    expect(store.usage).toHaveLength(1)
    const row = store.usage[0]
    expect(row.apiKeyId).toBe("key-1")
    expect(row.userId).toBe("user-1")
    expect(row.tool).toBe("list_domains")
    expect(row.status).toBe("SUCCESS")
    expect(row.durationMs).toBe(42)
    expect(Object.keys(row)).not.toContain("arguments")
    expect(Object.keys(row)).not.toContain("result")
  })

  it("records a failed tool execution as FAILED", async () => {
    await recordMcpCallOutcomes(
      fullAuth,
      requestBody,
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "nope" }], isError: true },
      },
      7
    )
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0].status).toBe("FAILED")
  })

  it("records a JSON-RPC error response as FAILED", async () => {
    await recordMcpCallOutcomes(
      fullAuth,
      requestBody,
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "boom" },
      },
      7
    )
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0].status).toBe("FAILED")
  })

  it("records nothing for non-tools/call methods", async () => {
    const outcomes = extractMcpCallOutcomes(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, result: {} }
    )
    expect(outcomes).toEqual([])
    await recordMcpCallOutcomes(
      fullAuth,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, result: {} },
      1
    )
    expect(store.usage).toHaveLength(0)
  })

  it("records nothing when the response cannot be matched to a request", async () => {
    await recordMcpCallOutcomes(
      fullAuth,
      requestBody,
      { jsonrpc: "2.0", id: 99, result: {} },
      1
    )
    expect(store.usage).toHaveLength(0)
  })

  it("never throws when the usage write fails", async () => {
    mockDb.mcpUsageRecord.create.mockRejectedValueOnce(
      new Error("database down")
    )
    await expect(
      recordMcpUsage({
        apiKeyId: "key-1",
        userId: "user-1",
        tool: "list_domains",
        status: "SUCCESS",
        durationMs: 1,
      })
    ).resolves.toBeUndefined()
    expect(store.usage).toHaveLength(0)
  })

  it("a refused-before-execution call records NO usage row", async () => {
    store.globalSettings = { globalEnabled: false }
    await expect(
      checkMcpAccess({ auth: fullAuth, tool: "list_domains" })
    ).rejects.toMatchObject({ status: 503 })
    expect(store.usage).toHaveLength(0)
  })
})

// ─── Admin service: global kill-switch ────────────────────────────────

describe("mcp-admin service — global settings", () => {
  it("returns enabled by default and creates the singleton row", async () => {
    await expect(getMcpSettings(ownerSession)).resolves.toEqual({
      globalEnabled: true,
    })
    expect(store.globalSettings).toEqual({ globalEnabled: true })
  })

  it("flips the switch and audits old/new values with the reason", async () => {
    const updated = await setMcpSettings(ownerSession, {
      globalEnabled: false,
      reason: "abuse investigation",
    })
    expect(updated).toEqual({ globalEnabled: false })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "MCP_SETTINGS",
        detail: expect.objectContaining({
          event: "mcp-global-toggled",
          reason: "abuse investigation",
          oldGlobalEnabled: true,
          newGlobalEnabled: false,
        }),
      })
    )
  })

  it("lets SUPPORT read the settings but not change them", async () => {
    await expect(getMcpSettings(supportSession)).resolves.toEqual({
      globalEnabled: true,
    })
    await expect(
      setMcpSettings(supportSession, {
        globalEnabled: false,
        reason: "nope",
      })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("forbids MANAGER from flipping the switch", async () => {
    await expect(
      setMcpSettings(managerSession, {
        globalEnabled: false,
        reason: "nope",
      })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("forbids a plain user from reading the settings", async () => {
    await expect(getMcpSettings(plainSession)).rejects.toMatchObject({
      status: 403,
    })
  })

  it("rejects a settings change without a reason at the schema", () => {
    expect(
      SetMcpSettingsSchema.safeParse({ globalEnabled: false }).success
    ).toBe(false)
    expect(
      SetMcpSettingsSchema.safeParse({ globalEnabled: false, reason: " " })
        .success
    ).toBe(false)
  })
})

// ─── Admin service: per-user controls ─────────────────────────────────

describe("mcp-admin service — per-user settings", () => {
  it("returns the defaults when no row exists", async () => {
    await expect(getUserMcpSettings(ownerSession, "user-1")).resolves.toEqual({
      userId: "user-1",
      isEnabled: true,
      allowedTools: null,
      minuteLimit: null,
      hourLimit: null,
    })
  })

  it("404s for an unknown user", async () => {
    await expect(
      getUserMcpSettings(ownerSession, "ghost")
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      setUserMcpSettings(ownerSession, "ghost", {
        isEnabled: false,
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("stores the controls and audits old/new values with the reason", async () => {
    const updated = await setUserMcpSettings(ownerSession, "user-1", {
      isEnabled: false,
      allowedTools: ["list_domains"],
      minuteLimit: 10,
      reason: "abuse investigation",
    })
    expect(updated).toEqual({
      userId: "user-1",
      isEnabled: false,
      allowedTools: ["list_domains"],
      minuteLimit: 10,
      hourLimit: null,
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "MCP_SETTINGS",
        resourceId: "user-1",
        detail: expect.objectContaining({
          event: "mcp-user-settings-changed",
          reason: "abuse investigation",
        }),
      })
    )
    const audit = mockLogAudit.mock.calls[0][0] as {
      detail: { old: unknown; new: unknown }
    }
    expect(audit.detail.old).toEqual({
      userId: "user-1",
      isEnabled: true,
      allowedTools: null,
      minuteLimit: null,
      hourLimit: null,
    })
    expect(audit.detail.new).toEqual(updated)
  })

  it("rejects an unknown tool name with 422", async () => {
    await expect(
      setUserMcpSettings(ownerSession, "user-1", {
        allowedTools: ["list_domains", "explode_everything"],
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects a zero minute limit with 422 (use the switch to block)", async () => {
    await expect(
      setUserMcpSettings(ownerSession, "user-1", {
        minuteLimit: 0,
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(
      SetUserMcpSettingsSchema.safeParse({
        minuteLimit: 0,
        reason: "x",
      }).success
    ).toBe(false)
  })

  it("rejects a negative hour limit with 422", async () => {
    await expect(
      setUserMcpSettings(ownerSession, "user-1", {
        hourLimit: -5,
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 422 })
  })

  it("keeps untouched fields on a partial update", async () => {
    await setUserMcpSettings(ownerSession, "user-1", {
      allowedTools: ["list_domains"],
      minuteLimit: 10,
      reason: "first",
    })
    const updated = await setUserMcpSettings(ownerSession, "user-1", {
      isEnabled: false,
      reason: "second",
    })
    expect(updated).toEqual({
      userId: "user-1",
      isEnabled: false,
      allowedTools: ["list_domains"],
      minuteLimit: 10,
      hourLimit: null,
    })
  })

  it("removes the allowlist when set to null", async () => {
    await setUserMcpSettings(ownerSession, "user-1", {
      allowedTools: ["list_domains"],
      reason: "first",
    })
    const updated = await setUserMcpSettings(ownerSession, "user-1", {
      allowedTools: null,
      reason: "second",
    })
    expect(updated.allowedTools).toBeNull()
  })

  it("forbids MANAGER from changing a user's controls", async () => {
    await expect(
      setUserMcpSettings(managerSession, "user-1", {
        isEnabled: false,
        reason: "x",
      })
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ─── Admin service: usage reporting ───────────────────────────────────

describe("mcp-admin service — usage reporting", () => {
  beforeEach(() => {
    const now = Date.now()
    seedUsage(
      "key-1",
      "user-1",
      "list_domains",
      "SUCCESS",
      new Date(now - 3000)
    )
    seedUsage(
      "key-1",
      "user-1",
      "list_domains",
      "SUCCESS",
      new Date(now - 2000)
    )
    seedUsage(
      "key-1",
      "user-1",
      "create_domain",
      "FAILED",
      new Date(now - 1000)
    )
    seedUsage("key-2", "user-2", "list_forms", "SUCCESS", new Date(now))
  })

  it("lists usage newest-first with pagination", async () => {
    const page1 = await listMcpUsage(
      ownerSession,
      McpUsageListQuerySchema.parse({ page: 1, perPage: 2 })
    )
    expect(page1.total).toBe(4)
    expect(page1.usage).toHaveLength(2)
    expect(page1.totalPages).toBe(2)
    expect(page1.usage[0].tool).toBe("list_forms")
    const page2 = await listMcpUsage(
      ownerSession,
      McpUsageListQuerySchema.parse({ page: 2, perPage: 2 })
    )
    expect(page2.usage).toHaveLength(2)
  })

  it("filters by user, tool, and status", async () => {
    const byUser = await listMcpUsage(
      ownerSession,
      McpUsageListQuerySchema.parse({ userId: "user-2" })
    )
    expect(byUser.total).toBe(1)
    const byTool = await listMcpUsage(
      ownerSession,
      McpUsageListQuerySchema.parse({ tool: "list_domains" })
    )
    expect(byTool.total).toBe(2)
    const failed = await listMcpUsage(
      ownerSession,
      McpUsageListQuerySchema.parse({ status: "FAILED" })
    )
    expect(failed.total).toBe(1)
    expect(failed.usage[0].tool).toBe("create_domain")
  })

  it("summarises totals, per-tool counts, top users, and the 24h error rate", async () => {
    const summary = await getMcpUsageSummary(
      ownerSession,
      McpUsageSummaryQuerySchema.parse({})
    )
    expect(summary.total).toBe(4)
    expect(summary.success).toBe(3)
    expect(summary.failed).toBe(1)
    expect(summary.errorRate24h).toBeCloseTo(0.25)
    expect(summary.byTool).toEqual([
      { tool: "list_domains", calls: 2, success: 2, failed: 0 },
      { tool: "create_domain", calls: 1, success: 0, failed: 1 },
      { tool: "list_forms", calls: 1, success: 1, failed: 0 },
    ])
    expect(summary.topUsers).toEqual([
      {
        userId: "user-1",
        name: "Owner One",
        email: "user-1@example.com",
        calls: 3,
      },
      {
        userId: "user-2",
        name: "Reader Two",
        email: "user-2@example.com",
        calls: 1,
      },
    ])
  })

  it("lets SUPPORT read usage (VIEW_MCP) but not a plain user", async () => {
    await expect(
      listMcpUsage(supportSession, McpUsageListQuerySchema.parse({}))
    ).resolves.toMatchObject({ total: 4 })
    await expect(
      listMcpUsage(plainSession, McpUsageListQuerySchema.parse({}))
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ─── Admin service: keys ──────────────────────────────────────────────

describe("mcp-admin service — keys", () => {
  beforeEach(() => {
    const now = Date.now()
    seedUsage(
      "key-1",
      "user-1",
      "list_domains",
      "SUCCESS",
      new Date(now - 1000)
    )
    seedUsage("key-1", "user-1", "get_domain", "SUCCESS", new Date(now))
    // 31 days old — outside the 30-day window.
    seedUsage(
      "key-2",
      "user-2",
      "list_forms",
      "SUCCESS",
      new Date(now - 31 * 24 * 60 * 60 * 1000)
    )
  })

  it("lists keys with owner, scope, and the 30-day call count — never the hash", async () => {
    const result = await listMcpKeys(ownerSession, 1, 20)
    expect(result.total).toBe(2)
    const key1 = result.keys.find((k) => k.id === "key-1")
    const key2 = result.keys.find((k) => k.id === "key-2")
    expect(key1).toMatchObject({
      name: "Key key-1",
      scope: "FULL",
      userId: "user-1",
      callsLast30Days: 2,
    })
    expect(key1?.user).toEqual({
      id: "user-1",
      name: "Owner One",
      email: "user-1@example.com",
    })
    expect(key2?.callsLast30Days).toBe(0)
    for (const key of result.keys) {
      expect(key).not.toHaveProperty("keyHash")
    }
  })

  it("revokes through @sendcms/api-keys and audits the admin action", async () => {
    const result = await revokeMcpKey(ownerSession, "key-1", "key leaked")
    expect(result).toEqual({ revoked: true, keyId: "key-1" })
    expect(mockRevokeApiKey).toHaveBeenCalledWith("user-1", "key-1")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELETE",
        resourceType: "API_KEY",
        resourceId: "key-1",
        detail: expect.objectContaining({
          event: "mcp-key-revoked",
          reason: "key leaked",
          ownerId: "user-1",
        }),
      })
    )
  })

  it("404s for an unknown key", async () => {
    await expect(
      revokeMcpKey(ownerSession, "ghost", "x")
    ).rejects.toMatchObject({ status: 404 })
    expect(mockRevokeApiKey).not.toHaveBeenCalled()
  })

  it("propagates a 409 from an already-revoked key without auditing", async () => {
    mockRevokeApiKey.mockRejectedValueOnce(
      new ApiError("API key is already revoked.", 409)
    )
    await expect(
      revokeMcpKey(ownerSession, "key-1", "x")
    ).rejects.toMatchObject({ status: 409 })
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("forbids MANAGER from revoking a key", async () => {
    await expect(
      revokeMcpKey(managerSession, "key-1", "x")
    ).rejects.toMatchObject({ status: 403 })
    expect(mockRevokeApiKey).not.toHaveBeenCalled()
  })

  it("requires a reason at the schema", () => {
    expect(RevokeMcpKeySchema.safeParse({}).success).toBe(false)
    expect(RevokeMcpKeySchema.safeParse({ reason: "key leaked" }).success).toBe(
      true
    )
  })
})

// ─── Validators ──────────────────────────────────────────────────────

describe("mcp-admin validators", () => {
  it("accepts a full per-user settings body", () => {
    expect(
      SetUserMcpSettingsSchema.safeParse({
        isEnabled: true,
        allowedTools: ["list_domains"],
        minuteLimit: 10,
        hourLimit: 100,
        reason: "ok",
      }).success
    ).toBe(true)
  })

  it("rejects a zero quota and a 20-tool allowlist", () => {
    expect(
      SetUserMcpSettingsSchema.safeParse({
        minuteLimit: 0,
        reason: "x",
      }).success
    ).toBe(false)
    expect(
      SetUserMcpSettingsSchema.safeParse({
        allowedTools: Array.from({ length: 20 }, (_, i) => `tool_${i}`),
        reason: "x",
      }).success
    ).toBe(false)
  })

  it("coerces string pagination params and rejects out-of-range values", () => {
    expect(
      McpPaginationQuerySchema.parse({ page: "2", perPage: "50" })
    ).toEqual({
      page: 2,
      perPage: 50,
    })
    expect(McpPaginationQuerySchema.safeParse({ page: 0 }).success).toBe(false)
    expect(McpPaginationQuerySchema.safeParse({ perPage: 500 }).success).toBe(
      false
    )
    expect(McpUsageListQuerySchema.safeParse({ status: "MAYBE" }).success).toBe(
      false
    )
  })
})
