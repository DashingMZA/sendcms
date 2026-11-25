// Wave 6 Stream B — delivery log requeue (EML-094/095), SENDING
// visibility (EML-094), test-email history + digest states
// (EML-096/093), digest helpers (EML-093), support-list fallback
// (DSH-405). Mocked Prisma client; no live DB needed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  emailJob: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  form: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
const mockSendEmail = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1", provider: "resend" }))
)
const mockRenderNotification = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>hi</p>", text: "hi" }))
)
vi.mock("@sendcms/email", () => ({
  notificationDeps: {
    sendEmail: mockSendEmail,
    renderNotification: mockRenderNotification,
    renderDigest: vi.fn(),
    renderReply: vi.fn(),
  },
}))

import { EmailJobStatus, EmailJobType } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"
import { buildPlainDigestSummary, getNextDigestAt } from "@sendcms/ai"
import {
  listDigestStatesForUser,
  listEmailJobsForUser,
  requeueEmailJob,
  sendTestSubmissionEmail,
} from "@sendcms/notifications"
import { MyTicketsQuerySchema } from "@sendcms/support/validators"

const NOW = new Date("2026-11-25T12:00:00Z")

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    type: EmailJobType.SUBMISSION_NOTIFICATION,
    to: "owner@example.com",
    subject: "New submission",
    status: EmailJobStatus.PENDING,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    providerMessageId: null,
    payload: null,
    createdAt: new Date("2026-11-25T10:00:00Z"),
    updatedAt: new Date("2026-11-25T10:00:00Z"),
    formId: "form-1",
    ownerId: "user-1",
    submissionId: "sub-1",
    form: { name: "Contact us" },
    ...overrides,
  }
}

async function expectApiError(promise: Promise<unknown>, status: number) {
  try {
    await promise
    throw new Error("expected an ApiError")
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockDb.emailJob.update.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      ...makeJob({ id: args.where.id }),
      ...args.data,
    })
  )
  mockDb.emailJob.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "job-new",
      ...args.data,
    })
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("listEmailJobsForUser (EML-094)", () => {
  function mockList(jobs: unknown[]) {
    mockDb.emailJob.findMany.mockResolvedValue(jobs)
    mockDb.emailJob.count.mockResolvedValue(jobs.length)
    mockDb.emailJob.groupBy.mockResolvedValue([
      { status: "PENDING", _count: 1 },
      { status: "SENDING", _count: 1 },
      { status: "SENT", _count: 1 },
      { status: "FAILED", _count: 1 },
    ])
  }

  it("counts SENDING separately and filters to it", async () => {
    const sending = makeJob({
      status: EmailJobStatus.SENDING,
      updatedAt: new Date(NOW.getTime() - 25 * 60_000),
    })
    mockList([sending])
    const result = await listEmailJobsForUser("user-1", {
      status: "SENDING",
    })
    expect(mockDb.emailJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SENDING" }),
      })
    )
    expect(result.counts).toEqual({
      all: 4,
      pending: 1,
      sending: 1,
      sent: 1,
      failed: 1,
    })
    expect(result.items[0].claimAgeMinutes).toBe(25)
    expect(result.items[0].canRequeue).toBe(true)
  })

  it("reports no claim age and no requeue for non-SENDING rows", async () => {
    mockList([makeJob({ status: EmailJobStatus.SENT })])
    const result = await listEmailJobsForUser("user-1", {})
    expect(result.items[0].claimAgeMinutes).toBeNull()
    expect(result.items[0].canRequeue).toBe(false)
  })

  it("does not offer requeue for a SENDING job inside the lease", async () => {
    mockList([
      makeJob({
        status: EmailJobStatus.SENDING,
        updatedAt: new Date(NOW.getTime() - 5 * 60_000),
      }),
    ])
    const result = await listEmailJobsForUser("user-1", {})
    expect(result.items[0].claimAgeMinutes).toBe(5)
    expect(result.items[0].canRequeue).toBe(false)
  })

  it("offers requeue for FAILED rows", async () => {
    mockList([makeJob({ status: EmailJobStatus.FAILED, lastError: "boom" })])
    const result = await listEmailJobsForUser("user-1", {})
    expect(result.items[0].canRequeue).toBe(true)
  })
})

describe("requeueEmailJob (EML-094/095)", () => {
  it("requeues a FAILED job to PENDING with a fresh ladder and audits it", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(
      makeJob({ status: EmailJobStatus.FAILED, attempts: 5 })
    )
    const job = await requeueEmailJob("user-1", "job-1")
    expect(job.status).toBe(EmailJobStatus.PENDING)
    expect(mockDb.emailJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        status: EmailJobStatus.PENDING,
        attempts: 0,
        nextAttemptAt: expect.any(Date),
      },
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "form-1",
        detail: expect.objectContaining({
          event: "email-job-requeued",
          emailJobId: "job-1",
          previousStatus: "FAILED",
          previousAttempts: 5,
        }),
      })
    )
  })

  it("requeues a SENDING job stuck past the lease", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(
      makeJob({
        status: EmailJobStatus.SENDING,
        attempts: 1,
        updatedAt: new Date(NOW.getTime() - 25 * 60_000),
      })
    )
    const job = await requeueEmailJob("user-1", "job-1")
    expect(job.status).toBe(EmailJobStatus.PENDING)
  })

  it("refuses a SENDING job still inside the lease with 409", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(
      makeJob({
        status: EmailJobStatus.SENDING,
        updatedAt: new Date(NOW.getTime() - 5 * 60_000),
      })
    )
    await expectApiError(requeueEmailJob("user-1", "job-1"), 409)
    expect(mockDb.emailJob.update).not.toHaveBeenCalled()
  })

  it("404s a job owned by someone else", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(
      makeJob({ status: EmailJobStatus.FAILED, ownerId: "user-2" })
    )
    await expectApiError(requeueEmailJob("user-1", "job-1"), 404)
    expect(mockDb.emailJob.update).not.toHaveBeenCalled()
  })

  it("404s a missing job", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(null)
    await expectApiError(requeueEmailJob("user-1", "job-1"), 404)
  })

  it("refuses PENDING and SENT jobs with 409", async () => {
    for (const status of [EmailJobStatus.PENDING, EmailJobStatus.SENT]) {
      mockDb.emailJob.findUnique.mockResolvedValue(makeJob({ status }))
      await expectApiError(requeueEmailJob("user-1", "job-1"), 409)
    }
    expect(mockDb.emailJob.update).not.toHaveBeenCalled()
  })
})

describe("sendTestSubmissionEmail history (EML-096)", () => {
  it("records a SENT test-email row in the delivery log", async () => {
    mockDb.form.findFirst.mockResolvedValue({
      id: "form-1",
      name: "Contact us",
    })
    const result = await sendTestSubmissionEmail(
      "user-1",
      "form-1",
      "owner@example.com"
    )
    expect(result).toEqual({ messageId: "msg-1", provider: "resend" })
    expect(mockDb.emailJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: EmailJobType.TEST_EMAIL,
        to: "owner@example.com",
        status: EmailJobStatus.SENT,
        providerMessageId: "msg-1",
        formId: "form-1",
        ownerId: "user-1",
      }),
    })
  })

  it("still returns the send result when the history record fails", async () => {
    mockDb.form.findFirst.mockResolvedValue({
      id: "form-1",
      name: "Contact us",
    })
    mockDb.emailJob.create.mockRejectedValue(new Error("db down"))
    const result = await sendTestSubmissionEmail(
      "user-1",
      "form-1",
      "owner@example.com"
    )
    expect(result).toEqual({ messageId: "msg-1", provider: "resend" })
  })
})

describe("listDigestStatesForUser (EML-093/096)", () => {
  it("computes last/next per form with the form's own interval", async () => {
    mockDb.form.findMany.mockResolvedValue([
      {
        id: "form-1",
        name: "Contact us",
        digestEnabled: true,
        digestIntervalHours: 168,
        lastDigestAt: new Date("2026-11-20T10:00:00Z"),
      },
      {
        id: "form-2",
        name: "Feedback",
        digestEnabled: false,
        digestIntervalHours: null,
        lastDigestAt: null,
      },
    ])
    const states = await listDigestStatesForUser("user-1")
    expect(states).toEqual([
      {
        formId: "form-1",
        formName: "Contact us",
        digestEnabled: true,
        digestIntervalHours: 168,
        lastDigestAt: new Date("2026-11-20T10:00:00Z"),
        nextDigestAt: new Date("2026-11-27T10:00:00Z"),
      },
      {
        formId: "form-2",
        formName: "Feedback",
        digestEnabled: false,
        digestIntervalHours: 24,
        lastDigestAt: null,
        nextDigestAt: null,
      },
    ])
  })
})

describe("digest helpers (EML-093)", () => {
  it("builds a plain summary without a model call", () => {
    const summary = buildPlainDigestSummary("Contact us", [
      {
        senderName: "Ali",
        senderEmail: "ali@example.com",
        snippet: "I need help.",
        receivedAt: new Date("2026-11-20T10:00:00Z"),
      },
      {
        senderName: null,
        senderEmail: null,
        snippet: "Hello.",
        receivedAt: new Date("2026-11-20T11:00:00Z"),
      },
    ])
    expect(summary.summary).toBe("2 new submissions on Contact us.")
    expect(summary.highlights).toEqual([
      "Ali: I need help.",
      "Unknown sender: Hello.",
    ])
  })

  it("computes the next digest from the last one plus the interval", () => {
    expect(getNextDigestAt(new Date("2026-11-20T10:00:00Z"), 24)).toEqual(
      new Date("2026-11-21T10:00:00Z")
    )
    expect(getNextDigestAt(null, 24)).toBeNull()
  })
})

describe("support list query fallback (DSH-405)", () => {
  it("falls back to {page: 1, perPage: 20} on any invalid param", () => {
    for (const raw of [
      { status: "BOGUS" },
      { page: "abc" },
      { perPage: "999" },
      { status: "OPEN", page: "0" },
    ]) {
      const parsed = MyTicketsQuerySchema.safeParse(raw)
      const filters = parsed.success
        ? parsed.data
        : MyTicketsQuerySchema.parse({})
      expect(filters).toEqual({ page: 1, perPage: 20 })
    }
  })

  it("keeps valid params", () => {
    const parsed = MyTicketsQuerySchema.safeParse({
      status: "OPEN",
      page: "2",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        status: "OPEN",
        page: 2,
        perPage: 20,
      })
    }
  })
})
