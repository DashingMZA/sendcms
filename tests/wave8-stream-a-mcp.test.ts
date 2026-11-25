// Phase 16, Wave 8 — Stream A (Billing P1 core).
//
// MCP allowlist fail-closed (SRC-303) and usage idempotency
// (DB-003). `parseMcpAllowedTools` is pure; `recordMcpUsage` /
// `recordMcpCallOutcomes` run against a mocked Prisma client. No
// test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"

const { store, mockDb } = vi.hoisted(() => {
  type StoredUsage = {
    id: string
    apiKeyId: string
    userId: string
    tool: string
    status: string
    durationMs: number | null
    idempotencyKey: string | null
  }
  const store = {
    usage: [] as StoredUsage[],
    keys: new Set<string>(),
    seq: 1,
  }
  const mockDb = {
    mcpUsageRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = data.idempotencyKey as string | null
        if (key && store.keys.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "1.0.0",
          })
        }
        const row: StoredUsage = {
          id: `usage-${store.seq++}`,
          apiKeyId: data.apiKeyId as string,
          userId: data.userId as string,
          tool: data.tool as string,
          status: data.status as string,
          durationMs: (data.durationMs as number | null) ?? null,
          idempotencyKey: key ?? null,
        }
        store.usage.push(row)
        if (key) store.keys.add(key)
        return row
      }),
    },
  }
  return { store, mockDb }
})
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import {
  parseMcpAllowedTools,
  recordMcpCallOutcomes,
  recordMcpUsage,
} from "@sendcms/mcp"

beforeEach(() => {
  vi.clearAllMocks()
  store.usage.length = 0
  store.keys.clear()
  store.seq = 1
})

describe("parseMcpAllowedTools (SRC-303)", () => {
  it("returns null when no allowlist is configured", () => {
    expect(parseMcpAllowedTools(null)).toBeNull()
    expect(parseMcpAllowedTools(undefined)).toBeNull()
  })

  it("returns a valid string array unchanged", () => {
    expect(parseMcpAllowedTools(["list_domains", "create_form"])).toEqual([
      "list_domains",
      "create_form",
    ])
    expect(parseMcpAllowedTools([])).toEqual([])
  })

  it("fails CLOSED on corrupt data — deny all tools, never fail open", () => {
    // The old code returned null here ("no allowlist"), which failed
    // OPEN to every in-scope tool. A corrupt row now denies all.
    expect(parseMcpAllowedTools("list_domains")).toEqual([])
    expect(parseMcpAllowedTools(42)).toEqual([])
    expect(parseMcpAllowedTools({ tools: ["list_domains"] })).toEqual([])
    expect(parseMcpAllowedTools(["list_domains", 42])).toEqual([])
    expect(parseMcpAllowedTools([null])).toEqual([])
    expect(parseMcpAllowedTools(true)).toEqual([])
  })
})

describe("recordMcpUsage idempotency (DB-003)", () => {
  const call = {
    apiKeyId: "key-1",
    userId: "user-1",
    tool: "list_domains",
    status: "SUCCESS" as const,
    durationMs: 5,
  }

  it("records the same call twice with the same key as ONE row", async () => {
    await recordMcpUsage({
      ...call,
      idempotencyKey: "mcp:key-1:7:list_domains:0",
    })
    await recordMcpUsage({
      ...call,
      idempotencyKey: "mcp:key-1:7:list_domains:0",
    })
    expect(store.usage).toHaveLength(1)
    expect(mockDb.mcpUsageRecord.create).toHaveBeenCalledTimes(2)
  })

  it("records two different keys as two rows", async () => {
    await recordMcpUsage({
      ...call,
      idempotencyKey: "mcp:key-1:7:list_domains:0",
    })
    await recordMcpUsage({
      ...call,
      idempotencyKey: "mcp:key-1:8:list_domains:0",
    })
    expect(store.usage).toHaveLength(2)
  })

  it("generates a key when the caller passes none", async () => {
    await recordMcpUsage(call)
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0].idempotencyKey).toBeTruthy()
    expect(typeof store.usage[0].idempotencyKey).toBe("string")
  })

  it("never throws when the usage write fails (non-P2002)", async () => {
    mockDb.mcpUsageRecord.create.mockRejectedValueOnce(
      new Error("database down")
    )
    await expect(recordMcpUsage(call)).resolves.toBeUndefined()
    expect(store.usage).toHaveLength(0)
  })
})

describe("recordMcpCallOutcomes idempotency (DB-003)", () => {
  const auth = { keyId: "key-1", userId: "user-1", scope: "FULL" as const }

  function toolsCall(id: number | string, tool = "list_domains") {
    return {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    }
  }

  function okResponse(id: number | string) {
    return { jsonrpc: "2.0", id, result: { content: [] } }
  }

  it("a retried round-trip (same JSON-RPC id) records once", async () => {
    const request = toolsCall(7)
    const response = okResponse(7)
    await recordMcpCallOutcomes(auth, request, response, 10)
    await recordMcpCallOutcomes(auth, request, response, 10)
    expect(store.usage).toHaveLength(1)
    expect(store.usage[0].tool).toBe("list_domains")
    expect(store.usage[0].status).toBe("SUCCESS")
  })

  it("a new request id records again (a new call, not a retry)", async () => {
    await recordMcpCallOutcomes(auth, toolsCall(7), okResponse(7), 10)
    await recordMcpCallOutcomes(auth, toolsCall(8), okResponse(8), 10)
    expect(store.usage).toHaveLength(2)
  })

  it("two tools in one batch with the same id both record (tool disambiguates)", async () => {
    await recordMcpCallOutcomes(
      auth,
      [toolsCall(7, "list_domains"), toolsCall(7, "create_form")],
      [okResponse(7), okResponse(7)],
      10
    )
    expect(store.usage).toHaveLength(2)
  })
})
