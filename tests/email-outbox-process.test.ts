// Email outbox processor (Phase 8): enqueue rules and the retry state
// machine, with a mocked Prisma client and provider.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: { findUnique: vi.fn() },
  notificationSettings: { findMany: vi.fn() },
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
vi.mock("@/lib/email/provider", () => ({
  sendPlatformEmail: vi.fn(),
}))

import {
  enqueueSubmissionNotifications,
  processEmailOutbox,
} from "@/lib/services/email-outbox"
import { sendPlatformEmail } from "@/lib/email/provider"

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    status: "NEW",
    data: { name: "Sara", email: "sara@example.com", message: "Hello" },
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    createdAt: new Date(),
    form: { id: "form-1", name: "Contact us" },
    ...overrides,
  }
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    type: "SUBMISSION_NOTIFICATION",
    to: "owner@example.com",
    subject: "New submission",
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    providerMessageId: null,
    formId: "form-1",
    submissionId: "sub-1",
    createdAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.submission.findUnique.mockResolvedValue(makeSubmission())
  mockDb.notificationSettings.findMany.mockResolvedValue([
    { email: "owner@example.com" },
  ])
  mockDb.emailJob.createMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.findMany.mockResolvedValue([])
  mockDb.emailJob.findUnique.mockResolvedValue({
    ...makeJob(),
    form: { id: "form-1", name: "Contact us" },
    submission: makeSubmission(),
  })
  mockDb.emailJob.updateMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.update.mockResolvedValue({})
  vi.mocked(sendPlatformEmail).mockResolvedValue({
    messageId: "msg-1",
    provider: "resend",
  })
})

describe("enqueueSubmissionNotifications", () => {
  it("creates one job per enabled recipient", async () => {
    const n = await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(n).toBe(1)
    expect(mockDb.emailJob.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ to: "owner@example.com" }),
        ]),
      })
    )
  })

  it("creates no job for a spam submission", async () => {
    mockDb.submission.findUnique.mockResolvedValue(
      makeSubmission({ status: "SPAM" })
    )
    const n = await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(n).toBe(0)
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })

  it("creates no job when there are no recipients", async () => {
    mockDb.notificationSettings.findMany.mockResolvedValue([])
    const n = await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(n).toBe(0)
  })

  it("creates no job for a missing submission", async () => {
    mockDb.submission.findUnique.mockResolvedValue(null)
    const n = await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(n).toBe(0)
  })
})

describe("processEmailOutbox", () => {
  it("does nothing when no jobs are due", async () => {
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 0, sent: 0, failed: 0 })
    expect(sendPlatformEmail).not.toHaveBeenCalled()
  })

  it("marks a delivered job SENT with the provider message id", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 })
    expect(mockDb.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SENT",
          providerMessageId: "msg-1",
          lastError: null,
          nextAttemptAt: null,
        }),
      })
    )
  })

  it("keeps a failed job PENDING with a backoff retry time", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    vi.mocked(sendPlatformEmail).mockRejectedValue(new Error("provider down"))
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null; lastError: string }
    }
    expect(updateArg.data.status).toBe("PENDING")
    expect(updateArg.data.nextAttemptAt).toBeInstanceOf(Date)
    expect(updateArg.data.lastError).toBe("provider down")
  })

  it("marks a job FAILED when its attempts are exhausted", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob({ attempts: 4 })])
    vi.mocked(sendPlatformEmail).mockRejectedValue(new Error("provider down"))
    const result = await processEmailOutbox()
    expect(result.failed).toBe(1)
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(updateArg.data.status).toBe("FAILED")
    expect(updateArg.data.nextAttemptAt).toBeNull()
  })

  it("marks a job FAILED when its submission is gone (terminal)", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    mockDb.emailJob.findUnique.mockResolvedValue({
      ...makeJob(),
      form: { id: "form-1", name: "Contact us" },
      submission: null,
    })
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("FAILED")
  })

  it("skips a job claimed by another processor", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    mockDb.emailJob.updateMany.mockResolvedValue({ count: 0 })
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 0 })
    expect(sendPlatformEmail).not.toHaveBeenCalled()
  })
})
