// Missed-notification reconciliation (DB-032 / EML-043): NEW
// submissions older than the cutoff with no EmailJob get their
// notification jobs (re-)created, exactly once — with the database
// and the enqueue path mocked, so these tests pin the reconciler's
// own decisions.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFindMany = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockEnqueue = vi.hoisted(() => vi.fn(async () => 1))
vi.mock("@sendcms/database", () => ({
  db: {
    submission: { findMany: mockFindMany },
    emailJob: { count: mockCount },
  },
  SubmissionStatus: {
    NEW: "NEW",
    SPAM: "SPAM",
    READ: "READ",
    STARRED: "STARRED",
    ARCHIVED: "ARCHIVED",
  },
}))
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: vi.fn(),
  enqueueSubmissionNotifications: mockEnqueue,
}))
vi.mock("@sendcms/submissions", () => ({
  rescoreNewSubmissions: vi.fn(),
  sendDueDigests: vi.fn(),
}))
vi.mock("@sendcms/plans", () => ({
  expireSubscriptions: vi.fn(),
}))

import { reconcileMissingNotificationJobs } from "@sendcms/cron"

const OLD_SUBMISSION = { id: "sub-old", formId: "form-1" }

beforeEach(() => {
  vi.clearAllMocks()
  mockFindMany.mockResolvedValue([OLD_SUBMISSION])
  mockCount.mockResolvedValue(0)
  mockEnqueue.mockResolvedValue(1)
})

describe("reconcileMissingNotificationJobs", () => {
  it("enqueues jobs for NEW submissions older than 10 minutes with no jobs", async () => {
    const result = await reconcileMissingNotificationJobs()
    expect(result).toEqual({ checked: 1, reconciled: 1, jobsCreated: 1 })
    expect(mockEnqueue).toHaveBeenCalledWith("form-1", "sub-old")
    const arg = mockFindMany.mock.calls[0][0] as {
      where: { status: string; createdAt: { lt: Date } }
      take: number
    }
    expect(arg.where.status).toBe("NEW")
    const ageMs = Date.now() - arg.where.createdAt.lt.getTime()
    expect(ageMs).toBeGreaterThanOrEqual(9.5 * 60_000)
    expect(ageMs).toBeLessThanOrEqual(10.5 * 60_000)
    expect(arg.take).toBe(25)
  })

  it("respects a custom age cutoff", async () => {
    await reconcileMissingNotificationJobs({ olderThanMinutes: 60 })
    const arg = mockFindMany.mock.calls[0][0] as {
      where: { createdAt: { lt: Date } }
    }
    const ageMs = Date.now() - arg.where.createdAt.lt.getTime()
    expect(ageMs).toBeGreaterThanOrEqual(59.5 * 60_000)
    expect(ageMs).toBeLessThanOrEqual(60.5 * 60_000)
  })

  it("skips submissions that already have jobs", async () => {
    mockCount.mockResolvedValue(3)
    const result = await reconcileMissingNotificationJobs()
    expect(result).toEqual({ checked: 1, reconciled: 0, jobsCreated: 0 })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("does not count a submission with no enabled recipients as reconciled", async () => {
    mockEnqueue.mockResolvedValue(0)
    const result = await reconcileMissingNotificationJobs()
    expect(result).toEqual({ checked: 1, reconciled: 0, jobsCreated: 0 })
  })

  it("enqueues exactly once across two runs", async () => {
    mockCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const first = await reconcileMissingNotificationJobs()
    expect(first).toEqual({ checked: 1, reconciled: 1, jobsCreated: 1 })
    const second = await reconcileMissingNotificationJobs()
    expect(second).toEqual({ checked: 1, reconciled: 0, jobsCreated: 0 })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it("enqueues one job set per recipient batch", async () => {
    mockFindMany.mockResolvedValue([
      { id: "sub-a", formId: "form-1" },
      { id: "sub-b", formId: "form-2" },
    ])
    mockEnqueue.mockResolvedValueOnce(2).mockResolvedValueOnce(1)
    const result = await reconcileMissingNotificationJobs()
    expect(result).toEqual({ checked: 2, reconciled: 2, jobsCreated: 3 })
  })
})
