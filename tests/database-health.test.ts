/**
 * Phase 16, SRC-305 — pingDatabase() returns its documented error
 * shape instead of throwing when the database is down.
 *
 * The real `db` is replaced at the client module boundary (the mocked
 * `$queryRaw` rejects), so no test hits a real database.
 */
import { describe, expect, it, vi } from "vitest"

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }))

vi.mock("../packages/database/src/client", () => ({
  db: { $queryRaw: mockQueryRaw },
}))

import { pingDatabase } from "../packages/database/src/health"

describe("pingDatabase (SRC-305)", () => {
  it("returns connected on success", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }])
    const result = await pingDatabase()
    expect(result.status).toBe("ok")
    expect(result.database).toBe("connected")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false)
  })

  it("returns the error shape instead of throwing when the query rejects", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"))
    const result = await pingDatabase()
    expect(result).toMatchObject({
      status: "error",
      database: "disconnected",
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false)
  })
})
