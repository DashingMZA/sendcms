// Wave 8, Stream C — MCP route pre-refusal (AIM-008) + rate-limit
// burst (AIM-017 / SRC-310).
//
// The route tests mock @sendcms/mcp but keep the REAL
// isToolAvailableForScope (spread from the actual module) — the
// pre-refusal decision is the unit under test. The burst test runs
// the REAL checkMcpRateLimit against a stateful fake whose
// conditional updateMany is atomic per call (no await between the
// where-check and the increment), modelling the DB's conditional
// UPDATE.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockResolveMcpAuth = vi.hoisted(() => vi.fn())
const mockCheckMcpAccess = vi.hoisted(() => vi.fn())
const mockCheckMcpRateLimit = vi.hoisted(() => vi.fn())
const mockCreateMcpServer = vi.hoisted(() => vi.fn())
const mockRecordMcpCallOutcomes = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/mcp")>()
  return {
    ...actual,
    resolveMcpAuth: mockResolveMcpAuth,
    checkMcpAccess: mockCheckMcpAccess,
    checkMcpRateLimit: mockCheckMcpRateLimit,
    createMcpServer: mockCreateMcpServer,
    recordMcpCallOutcomes: mockRecordMcpCallOutcomes,
  }
})

import { POST } from "../apps/api/app/api/mcp/route"

const URL = "http://localhost:3000/api/mcp"

function jsonRequest(body: unknown) {
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer mcp_test_key",
    },
    body: JSON.stringify(body),
  })
}

function toolsCall(tool: string, id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: tool, arguments: {} },
    id,
  }
}

describe("POST /api/mcp — AIM-008 scope pre-refusal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveMcpAuth.mockResolvedValue({
      keyId: "key-1",
      userId: "user-1",
      scope: "READ",
    })
    mockCheckMcpAccess.mockResolvedValue({ allowedTools: null })
    mockCheckMcpRateLimit.mockResolvedValue(undefined)
  })

  it("refuses a READ key's mutation before the rate limiter, with the SDK-identical -32602 body", async () => {
    const res = await POST(jsonRequest(toolsCall("create_form")))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Tool create_form not found" },
    })
    // No quota burned, no usage row written.
    expect(mockCheckMcpRateLimit).not.toHaveBeenCalled()
    expect(mockRecordMcpCallOutcomes).not.toHaveBeenCalled()
    expect(mockCheckMcpAccess).not.toHaveBeenCalled()
    expect(mockCreateMcpServer).not.toHaveBeenCalled()
  })

  it("refuses an unknown tool the same way, for any scope", async () => {
    mockResolveMcpAuth.mockResolvedValue({
      keyId: "key-1",
      userId: "user-1",
      scope: "FULL",
    })
    const res = await POST(jsonRequest(toolsCall("no_such_tool")))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Tool no_such_tool not found" },
    })
    expect(mockCheckMcpRateLimit).not.toHaveBeenCalled()
    expect(mockRecordMcpCallOutcomes).not.toHaveBeenCalled()
  })

  it("refuses all five mutations for a READ key, none of them touching quota", async () => {
    for (const tool of [
      "create_form",
      "update_form",
      "delete_form",
      "send_test_email",
      "update_submission",
    ]) {
      const res = await POST(jsonRequest(toolsCall(tool)))
      expect(res.status).toBe(200)
      expect((await res.json()).error.code).toBe(-32602)
    }
    expect(mockCheckMcpRateLimit).not.toHaveBeenCalled()
    expect(mockRecordMcpCallOutcomes).not.toHaveBeenCalled()
  })

  it("lets an allowed read tool past the pre-refusal (rate limiter runs)", async () => {
    // The transport run is out of scope here (createMcpServer is
    // mocked): the probe fails after the limiter, which is the
    // point — the pre-refusal did NOT block the call.
    mockCreateMcpServer.mockImplementation(() => {
      throw new Error("transport stub — not reached in this test")
    })
    const res = await POST(jsonRequest(toolsCall("list_domains")))
    expect(mockCheckMcpRateLimit).toHaveBeenCalledTimes(1)
    expect(mockCheckMcpRateLimit).toHaveBeenCalledWith("key-1", {
      minuteLimit: undefined,
      hourLimit: undefined,
    })
    // The stubbed transport failure surfaces as a 500, not a -32602.
    expect(res.status).toBe(500)
  })
})

// ─── Rate-limit burst (AIM-017 / SRC-310) ────────────────────────────────

const mockDb = vi.hoisted(() => {
  type Row = {
    apiKeyId: string
    minuteWindowStart: Date
    minuteCount: number
    hourWindowStart: Date
    hourCount: number
  }
  let row: Row | null = null
  function datesEqual(a: unknown, b: unknown): boolean {
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime()
    }
    return a === b
  }
  function isCondition(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false
    if (value instanceof Date) return false
    return ["lt", "lte", "gt", "gte", "not", "in"].some(
      (op) => op in (value as Record<string, unknown>)
    )
  }
  function matchesWhere(r: Row, where: Record<string, unknown>): boolean {
    for (const [field, value] of Object.entries(where)) {
      const current = (r as unknown as Record<string, unknown>)[field]
      if (isCondition(value)) {
        const cond = value as Record<string, unknown>
        if ("lt" in cond) {
          // Numbers (counts) and Dates (window starts) both use lt.
          const bound = cond.lt as number | Date
          if (current instanceof Date && bound instanceof Date) {
            if (!(current.getTime() < bound.getTime())) return false
          } else if (!(
            typeof current === "number" && current < (bound as number)
          )) {
            return false
          }
        } else if ("not" in cond) {
          if (datesEqual(current, cond.not)) return false
        } else {
          return false
        }
      } else if (!datesEqual(current, value)) {
        return false
      }
    }
    return true
  }
  return {
    apiKey: { findUnique: vi.fn(async () => null) },
    apiKeyRateLimit: {
      upsert: vi.fn(async ({ create }: { create: Row }) => {
        if (!row) row = { ...create }
        return row
      }),
      // Atomic per call: the where-check and the increment run in
      // one synchronous block with no await between them — the
      // in-test model of the DB's conditional UPDATE.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          if (!row || !matchesWhere(row, where)) return { count: 0 }
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in v) {
              ;(row as unknown as Record<string, number>)[k] += (
                v as { increment: number }
              ).increment
            } else {
              ;(row as unknown as Record<string, unknown>)[k] = v
            }
          }
          return { count: 1 }
        }
      ),
      findUnique: vi.fn(async () => row),
    },
    getRow: () => row,
    reset: () => {
      row = null
    },
  }
})
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import {
  checkMcpRateLimit,
  startOfUtcMinute,
} from "../packages/mcp/src/rate-limit"

describe("checkMcpRateLimit burst (AIM-017)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.reset()
  })

  it("admits exactly 120 of 150 concurrent calls per minute (429 for the rest)", async () => {
    const results = await Promise.all(
      Array.from({ length: 150 }, () =>
        checkMcpRateLimit("key-1").then(
          () => "admitted",
          (err: { status?: number }) => err.status ?? "thrown"
        )
      )
    )
    const admitted = results.filter((r) => r === "admitted").length
    const denied = results.filter((r) => r === 429).length
    expect(admitted).toBe(120)
    expect(denied).toBe(30)
    // The stored counter equals the admitted count — a denied call
    // increments nothing.
    expect(mockDb.getRow()?.minuteCount).toBe(120)
    expect(mockDb.getRow()?.hourCount).toBe(120)
  })

  it("admits again once the minute window rolls over", async () => {
    for (let i = 0; i < 120; i++) await checkMcpRateLimit("key-1")
    await expect(checkMcpRateLimit("key-1")).rejects.toMatchObject({
      status: 429,
    })
    // A new minute: the atomic reset path admits again.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.now() + 61_000))
      await expect(checkMcpRateLimit("key-1")).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a stale request from the previous minute never rewinds the window (SRC-310)", async () => {
    // Live burst 2026-11-25: with a { not: } reset, a request whose
    // `now` was captured before the rollover reset the counter to 0
    // mid-burst — 61 calls admitted in one wall-clock minute while
    // minuteCount read 17. The reset is forward-only now.
    for (let i = 0; i < 3; i++) await checkMcpRateLimit("key-1")
    vi.useFakeTimers()
    try {
      const before = new Date()
      vi.setSystemTime(new Date(before.getTime() + 61_000))
      // One call in the new minute moves the row forward.
      await checkMcpRateLimit("key-1")
      expect(mockDb.getRow()?.minuteCount).toBe(1)
      // A request whose clock still reads the old minute (started
      // before the rollover, processed after it) must be denied —
      // and must leave the new window's count untouched.
      vi.setSystemTime(before)
      await expect(checkMcpRateLimit("key-1")).rejects.toMatchObject({
        status: 429,
      })
      expect(mockDb.getRow()?.minuteCount).toBe(1)
      expect(mockDb.getRow()?.minuteWindowStart.getTime()).toBe(
        startOfUtcMinute(new Date(before.getTime() + 61_000)).getTime()
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
