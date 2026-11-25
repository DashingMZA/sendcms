// Email outbox processor (Phase 9): enqueue rules and the retry state
// machine, with a mocked Prisma client and email package. The processor
// imports its send path from `@sendcms/email` directly now (no injected
// deps), so the test mocks that module; the queue state machine lives
// in `@sendcms/queue` and is covered by tests/queue.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: { findUnique: vi.fn() },
  submissionEvent: { create: vi.fn() },
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
import {
  enqueueSubmissionNotifications,
  processEmailOutbox,
} from "@sendcms/notifications"

const mockSendEmail = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1", provider: "resend" }))
)
const mockRenderNotification = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>hi</p>", text: "hi" }))
)
const mockRenderDigest = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>digest</p>", text: "digest" }))
)
const mockRenderReply = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>reply</p>", text: "reply" }))
)
vi.mock("@sendcms/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/email")>()
  return {
    ...actual,
    notificationDeps: {
      sendEmail: mockSendEmail,
      renderNotification: mockRenderNotification,
      renderDigest: mockRenderDigest,
      renderReply: mockRenderReply,
    },
  }
})
// The service resolves the owner's locale for subjects/footers
// (Wave 7, EML-010); the mock returns no preference → English.
vi.mock("@sendcms/users", () => ({
  getUserLocale: vi.fn(async () => null),
}))

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    status: "NEW",
    data: { name: "Sara", email: "sara@example.com", message: "Hello" },
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    createdAt: new Date(),
    form: { id: "form-1", name: "Contact us", ownerId: "user-1" },
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
  mockDb.submissionEvent.create.mockResolvedValue({})
  mockSendEmail.mockResolvedValue({
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
          expect.objectContaining({
            to: "owner@example.com",
            // Phase 16 (DB-034): the created job carries its form's
            // owner — the outbox listing filters on it, not on a join.
            ownerId: "user-1",
          }),
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
    expect(mockSendEmail).not.toHaveBeenCalled()
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
    // EML-007: a plain notification job writes no timeline event.
    expect(mockDb.submissionEvent.create).not.toHaveBeenCalled()
  })

  it("keeps a failed job PENDING with a backoff retry time", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    mockSendEmail.mockRejectedValue(new Error("provider down"))
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
    mockSendEmail.mockRejectedValue(new Error("provider down"))
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
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it("sends a DIGEST job from its stored payload without a submission", async () => {
    const digestJob = makeJob({
      type: "DIGEST",
      submissionId: null,
      payload: {
        formName: "Contact us",
        count: 2,
        summary: "Two customers asked about orders.",
        highlights: ["Ali needs help with an order."],
        items: [
          {
            senderName: "Ali",
            snippet: "I need help with my order.",
            receivedAt: new Date("2026-11-20T10:00:00Z"),
          },
        ],
        inboxUrl: "http://localhost:3002/dashboard/inbox?formId=form-1",
        accentColor: "#0891b2",
        footerText: "Digest footer.",
      },
    })
    mockDb.emailJob.findMany.mockResolvedValue([digestJob])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 })
    expect(mockRenderDigest).toHaveBeenCalledWith(
      expect.objectContaining({ formName: "Contact us", count: 2 })
    )
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com" })
    )
  })

  it("fails a DIGEST job terminally when its payload is malformed", async () => {
    const digestJob = makeJob({
      type: "DIGEST",
      submissionId: null,
      payload: { formName: "Contact us" },
    })
    mockDb.emailJob.findMany.mockResolvedValue([digestJob])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 })
    expect(mockRenderDigest).not.toHaveBeenCalled()
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("FAILED")
  })

  it("sends a SUBMISSION_REPLY job from its stored payload", async () => {
    const replyJob = makeJob({
      type: "SUBMISSION_REPLY",
      to: "ali@example.com",
      subject: "Re: your order",
      payload: {
        formName: "Contact us",
        body: "Hi Ali, your order is on its way.",
        accentColor: "#0891b2",
        footerText: "Reply footer.",
      },
    })
    mockDb.emailJob.findMany.mockResolvedValue([replyJob])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 })
    expect(mockRenderReply).toHaveBeenCalledWith(
      expect.objectContaining({
        formName: "Contact us",
        body: "Hi Ali, your order is on its way.",
      })
    )
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ali@example.com" })
    )
    // EML-007: EMAIL_SENT is written from the send path, on delivery —
    // not at enqueue time.
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submissionId: "sub-1",
        type: "EMAIL_SENT",
        detail: { reply: true },
      }),
    })
  })

  it("fails a SUBMISSION_REPLY job terminally when its payload is malformed", async () => {
    const replyJob = makeJob({
      type: "SUBMISSION_REPLY",
      payload: { formName: "Contact us" },
    })
    mockDb.emailJob.findMany.mockResolvedValue([replyJob])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 })
    expect(mockRenderReply).not.toHaveBeenCalled()
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("FAILED")
    // EML-007: a terminal reply failure gets an EMAIL_FAILED event.
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submissionId: "sub-1",
        type: "EMAIL_FAILED",
        detail: expect.objectContaining({ reply: true }),
      }),
    })
  })

  it("writes no timeline event for a retriable reply failure (EML-007)", async () => {
    const replyJob = makeJob({
      type: "SUBMISSION_REPLY",
      to: "ali@example.com",
      subject: "Re: your order",
      payload: {
        formName: "Contact us",
        body: "Hi Ali, your order is on its way.",
        accentColor: "#0891b2",
        footerText: "Reply footer.",
      },
    })
    mockDb.emailJob.findMany.mockResolvedValue([replyJob])
    mockSendEmail.mockRejectedValue(new Error("provider down"))
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("PENDING")
    expect(mockDb.submissionEvent.create).not.toHaveBeenCalled()
  })
})
