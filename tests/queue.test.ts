// Email outbox queue (Phase 9): the claim + retry state machine over
// the EmailJob table, with a mocked Prisma client.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  emailJob: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
import {
  MAX_EMAIL_ATTEMPTS,
  claimDueEmailJobs,
  claimEmailJob,
  enqueueEmailJobs,
  loadEmailJob,
  markEmailJobFailed,
  markEmailJobSent,
  nextAttemptDelayMs,
} from "@sendcms/queue"

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.emailJob.createMany.mockResolvedValue({ count: 2 })
  mockDb.emailJob.findMany.mockResolvedValue([])
  mockDb.emailJob.findUnique.mockResolvedValue(null)
  mockDb.emailJob.updateMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.update.mockResolvedValue({})
})

describe("nextAttemptDelayMs", () => {
  it("backs off 1m, 5m, 15m, 1h, 4h", () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000)
    expect(nextAttemptDelayMs(2)).toBe(5 * 60_000)
    expect(nextAttemptDelayMs(3)).toBe(15 * 60_000)
    expect(nextAttemptDelayMs(4)).toBe(60 * 60_000)
    expect(nextAttemptDelayMs(5)).toBe(4 * 60 * 60_000)
  })

  it("clamps below 1 and above the last delay", () => {
    expect(nextAttemptDelayMs(0)).toBe(60_000)
    expect(nextAttemptDelayMs(MAX_EMAIL_ATTEMPTS + 1)).toBe(4 * 60 * 60_000)
  })
})

describe("enqueueEmailJobs", () => {
  it("creates the jobs and returns the count", async () => {
    const n = await enqueueEmailJobs([
      {
        type: "SUBMISSION_NOTIFICATION",
        to: "owner@example.com",
        subject: "New submission",
        formId: "form-1",
        submissionId: "sub-1",
      },
    ])
    expect(n).toBe(2)
    expect(mockDb.emailJob.createMany).toHaveBeenCalledTimes(1)
  })

  it("creates nothing for an empty list", async () => {
    const n = await enqueueEmailJobs([])
    expect(n).toBe(0)
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })
})

describe("claimDueEmailJobs", () => {
  it("fetches due PENDING jobs, oldest first, clamped to 1..100", async () => {
    await claimDueEmailJobs(200)
    expect(mockDb.emailJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING" }),
        orderBy: { createdAt: "asc" },
        take: 100,
      })
    )
    await claimDueEmailJobs(0)
    expect(mockDb.emailJob.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 })
    )
  })
})

describe("claimEmailJob", () => {
  it("flips PENDING → SENDING atomically and reports the claim", async () => {
    const claimed = await claimEmailJob("job-1")
    expect(claimed).toBe(true)
    expect(mockDb.emailJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "PENDING" },
      data: {
        status: "SENDING",
        attempts: { increment: 1 },
      },
    })
  })

  it("returns false when another processor claimed the job", async () => {
    mockDb.emailJob.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimEmailJob("job-1")).resolves.toBe(false)
  })
})

describe("loadEmailJob", () => {
  it("loads the job with its form + submission", async () => {
    await loadEmailJob("job-1")
    expect(mockDb.emailJob.findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
      include: {
        form: { select: { id: true, name: true } },
        submission: true,
      },
    })
  })
})

describe("markEmailJobSent", () => {
  it("marks the job SENT with the provider message id", async () => {
    await markEmailJobSent("job-1", "msg-1")
    expect(mockDb.emailJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        status: "SENT",
        providerMessageId: "msg-1",
        lastError: null,
        nextAttemptAt: null,
      },
    })
  })
})

describe("markEmailJobFailed", () => {
  it("keeps a retriable failure PENDING with a backoff retry time", async () => {
    await markEmailJobFailed("job-1", { error: "provider down", attempts: 1 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null; lastError: string }
    }
    expect(updateArg.data.status).toBe("PENDING")
    expect(updateArg.data.nextAttemptAt).toBeInstanceOf(Date)
    expect(updateArg.data.lastError).toBe("provider down")
  })

  it("marks a job FAILED when its attempts are exhausted", async () => {
    await markEmailJobFailed("job-1", {
      error: "provider down",
      attempts: MAX_EMAIL_ATTEMPTS,
    })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(updateArg.data.status).toBe("FAILED")
    expect(updateArg.data.nextAttemptAt).toBeNull()
  })

  it("marks a job FAILED when the failure is terminal", async () => {
    await markEmailJobFailed("job-1", {
      error: "Submission or form no longer exists.",
      attempts: 1,
      terminal: true,
    })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(updateArg.data.status).toBe("FAILED")
    expect(updateArg.data.nextAttemptAt).toBeNull()
  })

  it("truncates a long error message", async () => {
    await markEmailJobFailed("job-1", { error: "x".repeat(600), attempts: 1 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { lastError: string }
    }
    expect(updateArg.data.lastError.length).toBe(501)
    expect(updateArg.data.lastError.endsWith("…")).toBe(true)
  })
})
