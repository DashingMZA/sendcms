// MCP server gates (Phase 11): protocol-level tests over an in-memory
// transport — a real MCP client lists the tools and calls them against
// mocked services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

const mockDb = vi.hoisted(() => ({
  domain: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  form: { count: vi.fn(), findMany: vi.fn() },
  submission: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  apiKeyRateLimit: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  auditLog: { create: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import { checkMcpRateLimit, createMcpServer } from "@sendcms/mcp"
import type { McpAuthContext } from "@sendcms/mcp"

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

// ─── Store-backed ApiKeyRateLimit fake ───────────────────────────────
// The limiter's atomicity in production comes from Postgres: each
// claim is ONE conditional UPDATE statement, so concurrent claims
// serialize on the row. This fake mirrors exactly that guarantee —
// each mocked call matches + applies synchronously (no await between
// the WHERE check and the write), so a Promise.all burst cannot
// interleave inside one statement, just as it cannot inside the real
// single-statement UPDATE. The fake does NOT re-implement the
// limiter's decision logic (that lives in the real code under test);
// it only provides the atomic store.
type RateLimitRow = {
  apiKeyId: string
  minuteWindowStart: Date
  minuteCount: number
  hourWindowStart: Date
  hourCount: number
}

const rateStore = new Map<string, RateLimitRow>()

function rateWindowStarts(now = new Date()) {
  const minuteStart = new Date(now)
  minuteStart.setSeconds(0, 0)
  const hourStart = new Date(now)
  hourStart.setMinutes(0, 0, 0)
  return { minuteStart, hourStart }
}

function seedRateRow(overrides: Partial<RateLimitRow> = {}): RateLimitRow {
  const { minuteStart, hourStart } = rateWindowStarts()
  const row: RateLimitRow = {
    apiKeyId: "key-1",
    minuteWindowStart: minuteStart,
    minuteCount: 0,
    hourWindowStart: hourStart,
    hourCount: 0,
    ...overrides,
  }
  rateStore.set(row.apiKeyId, row)
  return row
}

function rateWhereMatches(
  row: RateLimitRow,
  where: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(where)) {
    const current = row[key as keyof RateLimitRow]
    if (
      typeof value === "object" &&
      value !== null &&
      "lt" in (value as Record<string, unknown>)
    ) {
      // Counts (numbers) and window starts (Dates) both use lt —
      // the reset is forward-only (SRC-310), so a Date lt is the
      // rollover check.
      const bound = (value as { lt: number | Date }).lt
      if (current instanceof Date && bound instanceof Date) {
        if (current.getTime() >= bound.getTime()) return false
      } else if (typeof current !== "number" || current >= (bound as number)) {
        return false
      }
    } else if (
      typeof value === "object" &&
      value !== null &&
      "not" in (value as Record<string, unknown>)
    ) {
      const not = (value as { not: unknown }).not
      if (
        current instanceof Date &&
        not instanceof Date &&
        current.getTime() === not.getTime()
      ) {
        return false
      }
      if (current === not) return false
    } else if (value instanceof Date) {
      if (!(current instanceof Date) || current.getTime() !== value.getTime()) {
        return false
      }
    } else if (current !== value) {
      return false
    }
  }
  return true
}

function applyRateData(row: RateLimitRow, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "increment" in (value as Record<string, unknown>)
    ) {
      const field = key as "minuteCount" | "hourCount"
      row[field] += (value as { increment: number }).increment
    } else {
      ;(row as Record<string, unknown>)[key] = value
    }
  }
}

const ALL_TOOLS = [
  "list_domains",
  "get_domain",
  "create_domain",
  "verify_domain",
  "delete_domain",
  "list_forms",
  "get_form",
  "create_form",
  "update_form",
  "delete_form",
  "list_submissions",
  "get_submission",
  "update_submission",
  "bulk_update_submissions",
  "delete_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
  "send_test_email",
]

const READ_TOOLS = [
  "list_domains",
  "get_domain",
  "list_forms",
  "get_form",
  "list_submissions",
  "get_submission",
  "get_overview",
  "get_analytics",
  "list_email_jobs",
]

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
  return { client, server }
}

function toolText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] })
    .content
  return content[0].text
}

let connected: {
  client: Client
  server: ReturnType<typeof createMcpServer>
} | null = null

afterEach(async () => {
  if (connected) {
    await connected.client.close().catch(() => {})
    await connected.server.close().catch(() => {})
    connected = null
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.domain.count.mockResolvedValue(2)
  mockDb.form.count.mockResolvedValue(1)
  mockDb.submission.count.mockResolvedValue(3)
  mockDb.submission.findMany.mockResolvedValue([])
  mockDb.submission.groupBy.mockResolvedValue([])
  mockDb.form.findMany.mockResolvedValue([])
  rateStore.clear()
  mockDb.apiKeyRateLimit.findUnique.mockImplementation(
    async ({ where }: { where: { apiKeyId: string } }) =>
      rateStore.get(where.apiKeyId) ?? null
  )
  mockDb.apiKeyRateLimit.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { apiKeyId: string }
      create: RateLimitRow
      update: Record<string, unknown>
    }) => {
      const existing = rateStore.get(where.apiKeyId)
      if (existing) {
        applyRateData(existing, update)
        return existing
      }
      const row: RateLimitRow = { ...create }
      rateStore.set(where.apiKeyId, row)
      return row
    }
  )
  mockDb.apiKeyRateLimit.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      const row = rateStore.get(where.apiKeyId as string)
      if (!row || !rateWhereMatches(row, where)) return { count: 0 }
      applyRateData(row, data)
      return { count: 1 }
    }
  )
})

describe("tools/list", () => {
  it("a FULL key sees all 19 tools", async () => {
    connected = await connectClient(fullAuth)
    const { tools } = await connected.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it("a READ key sees only the 9 read-only tools", async () => {
    connected = await connectClient(readAuth)
    const { tools } = await connected.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort())
  })
})

describe("tools/call", () => {
  it("list_domains returns the owner's domains as JSON", async () => {
    const domain = {
      id: "dom-1",
      name: "example.com",
      domain: "example.com",
      status: "VERIFIED",
      ownerId: "user-1",
      verifications: [],
      _count: { formLinks: 1 },
    }
    mockDb.domain.findMany.mockResolvedValue([domain])
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "list_domains",
      arguments: {},
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].domain).toBe("example.com")
  })

  it("get_overview returns the mocked counts", async () => {
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_overview",
      arguments: {},
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed.domainCount).toBe(2)
    expect(parsed.formCount).toBe(1)
    expect(parsed.submissionCount).toBe(3)
  })

  it("get_analytics returns the mocked breakdown", async () => {
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_analytics",
      arguments: { days: 7 },
    })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(result))
    expect(parsed.total).toBe(3)
    expect(parsed.byDay).toHaveLength(7)
  })

  it("get_domain with an unknown id is a tool error, not a crash", async () => {
    mockDb.domain.findFirst.mockResolvedValue(null)
    connected = await connectClient(fullAuth)
    const result = await connected.client.callTool({
      name: "get_domain",
      arguments: { domainId: "nope" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Domain not found")
  })

  it("a READ key cannot call a mutation tool", async () => {
    connected = await connectClient(readAuth)
    // The server answers with a tool error, not a crash — the client
    // sees "Tool create_domain not found".
    const result = await connected.client.callTool({
      name: "create_domain",
      arguments: { domain: "example.com" },
    })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain("Tool create_domain not found")
  })
})

describe("checkMcpRateLimit", () => {
  it("passes under the limits and counts the call once", async () => {
    await checkMcpRateLimit("key-1")
    expect(rateStore.get("key-1")).toMatchObject({
      minuteCount: 1,
      hourCount: 1,
    })
  })

  it("429s past the per-minute limit and does not increment", async () => {
    seedRateRow({ minuteCount: 120, hourCount: 50 })
    await expect(checkMcpRateLimit("key-1")).rejects.toThrowError(
      "Too many MCP requests"
    )
    expect(rateStore.get("key-1")).toMatchObject({
      minuteCount: 120,
      hourCount: 50,
    })
  })

  it("429s past the per-hour limit and does not increment", async () => {
    seedRateRow({ minuteCount: 1, hourCount: 2000 })
    await expect(checkMcpRateLimit("key-1")).rejects.toThrowError(
      "Too many MCP requests"
    )
    expect(rateStore.get("key-1")).toMatchObject({
      minuteCount: 1,
      hourCount: 2000,
    })
  })

  it("rolls a stale window over instead of denying", async () => {
    const staleMinute = new Date(Date.now() - 60_000)
    staleMinute.setSeconds(0, 0)
    seedRateRow({ minuteWindowStart: staleMinute, minuteCount: 120 })
    await checkMcpRateLimit("key-1")
    expect(rateStore.get("key-1")).toMatchObject({
      minuteCount: 1,
      hourCount: 1,
    })
  })

  // TST-006 / AIM-007: the regression test for the read-then-upsert
  // race. The audit's live burst (150 concurrent calls vs 120/min)
  // returned 150×200; with the atomic claim exactly 120 are
  // admitted, the rest are 429, and the stored counter equals the
  // admitted count. Fails on the old implementation (all 130 admit,
  // counter advances ~1 per batch).
  it("a 130-call burst in batches of 10 admits exactly 120", async () => {
    const results: string[] = []
    for (let batch = 0; batch < 13; batch++) {
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          checkMcpRateLimit("key-1").then(
            () => "ok",
            (err: unknown) => (err instanceof Error ? err.message : String(err))
          )
        )
      )
      results.push(...outcomes)
    }
    expect(results.filter((r) => r === "ok")).toHaveLength(120)
    const denied = results.filter((r) => r !== "ok")
    expect(denied).toHaveLength(10)
    expect(denied.every((r) => r.includes("Too many MCP requests"))).toBe(true)
    expect(rateStore.get("key-1")).toMatchObject({
      minuteCount: 120,
      hourCount: 120,
    })
  })
})
