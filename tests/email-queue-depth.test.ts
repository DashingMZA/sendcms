// Email queue depth + recent failed jobs (EML-035, EML-014): the
// read-only outbox queries behind the worker's health endpoint —
// with only the Prisma client swapped for a fake, so these tests pin
// the queries themselves.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCount = vi.hoisted(() => vi.fn())
const mockFindFirst = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return {
    ...actual,
    db: {
      emailJob: {
        count: mockCount,
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
    },
  }
})

import {
  getEmailQueueDepth,
  getRecentFailedEmailJobs,
} from "@sendcms/platform-ops"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getEmailQueueDepth", () => {
  it("returns per-status counts plus the stuck-claim age", async () => {
    mockCount
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
    mockFindFirst.mockResolvedValue({
      updatedAt: new Date(Date.now() - 45 * 60_000),
    })
    const depth = await getEmailQueueDepth()
    expect(depth).toMatchObject({
      pending: 5,
      pendingDue: 3,
      sending: 1,
      failed: 2,
    })
    expect(depth.stuckSendingAgeMinutes).toBeGreaterThanOrEqual(44)
    expect(depth.stuckSendingAgeMinutes).toBeLessThanOrEqual(46)
    // The due count only counts PENDING jobs whose attempt is due.
    const dueCall = mockCount.mock.calls[1][0] as {
      where: { status: string; OR: unknown[] }
    }
    expect(dueCall.where.status).toBe("PENDING")
    expect(dueCall.where.OR).toHaveLength(2)
  })

  it("reports null stuck age when nothing is SENDING", async () => {
    mockCount.mockResolvedValue(0)
    mockFindFirst.mockResolvedValue(null)
    const depth = await getEmailQueueDepth()
    expect(depth.stuckSendingAgeMinutes).toBeNull()
    expect(depth).toMatchObject({
      pending: 0,
      pendingDue: 0,
      sending: 0,
      failed: 0,
    })
  })
})

describe("getRecentFailedEmailJobs", () => {
  it("returns failed jobs most recent first with ISO timestamps", async () => {
    const since = new Date(Date.now() - 60_000)
    const failedAt = new Date()
    mockFindMany.mockResolvedValue([
      {
        id: "job-1",
        type: "SUBMISSION_NOTIFICATION",
        to: "owner@example.com",
        attempts: 2,
        lastError: "No email provider configured",
        nextAttemptAt: new Date(Date.now() + 60_000),
        updatedAt: failedAt,
      },
    ])
    const jobs = await getRecentFailedEmailJobs(since)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: "job-1",
      type: "SUBMISSION_NOTIFICATION",
      to: "owner@example.com",
      attempts: 2,
      lastError: "No email provider configured",
    })
    expect(jobs[0].updatedAt).toBe(failedAt.toISOString())
    expect(typeof jobs[0].nextAttemptAt).toBe("string")
    const arg = mockFindMany.mock.calls[0][0] as {
      where: { updatedAt: { gte: Date }; lastError: unknown; status: unknown }
      orderBy: unknown
    }
    expect(arg.where.updatedAt.gte).toBe(since)
    expect(arg.where.lastError).toEqual({ not: null })
    expect(arg.orderBy).toEqual({ updatedAt: "desc" })
  })

  it("returns an empty list when nothing failed", async () => {
    mockFindMany.mockResolvedValue([])
    const jobs = await getRecentFailedEmailJobs(new Date())
    expect(jobs).toEqual([])
  })
})
