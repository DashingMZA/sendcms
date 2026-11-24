// EmailJob.ownerId denormalization (Phase 16, Wave 3, DB-034): the
// outbox listing filters on the denormalized owner instead of joining
// Form, and every enqueue site stamps the job with its form's owner.
// Mocked Prisma client, in the suite's existing style — the assertions
// are on the query/create shapes, not on a live database.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: { findUnique: vi.fn() },
  notificationSettings: { findMany: vi.fn() },
  form: { findUnique: vi.fn() },
  emailJob: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/email", () => ({
  notificationDeps: {
    sendEmail: vi.fn(),
    renderNotification: vi.fn(),
    renderDigest: vi.fn(),
    renderReply: vi.fn(),
  },
}))
import {
  enqueueDigest,
  enqueueReply,
  enqueueSubmissionNotifications,
  listEmailJobsForUser,
} from "@sendcms/notifications"

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    status: "NEW",
    data: { name: "Sara", email: "sara@example.com", message: "Hello" },
    form: { id: "form-1", name: "Contact us", ownerId: "user-1" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.submission.findUnique.mockResolvedValue(makeSubmission())
  mockDb.notificationSettings.findMany.mockResolvedValue([
    { email: "owner@example.com" },
  ])
  mockDb.form.findUnique.mockResolvedValue({ ownerId: "user-1" })
  mockDb.emailJob.createMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.findMany.mockResolvedValue([])
  mockDb.emailJob.count.mockResolvedValue(0)
  mockDb.emailJob.groupBy.mockResolvedValue([])
})

describe("enqueueSubmissionNotifications (DB-034)", () => {
  it("stamps the created job with its form owner's id", async () => {
    await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(mockDb.emailJob.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          formId: "form-1",
          ownerId: "user-1",
          to: "owner@example.com",
        }),
      ],
    })
  })
})

describe("enqueueDigest (DB-034)", () => {
  it("resolves the form's owner and stamps the created job with it", async () => {
    await enqueueDigest({
      formId: "form-1",
      to: "owner@example.com",
      subject: "2 new submissions on Contact us",
      payload: {
        formName: "Contact us",
        count: 2,
        summary: "Two customers wrote in.",
        highlights: [],
        items: [],
        inboxUrl: "http://localhost:3002/dashboard/inbox?formId=form-1",
        accentColor: "#0891b2",
        footerText: "Digest footer.",
      },
    })
    expect(mockDb.form.findUnique).toHaveBeenCalledWith({
      where: { id: "form-1" },
      select: { ownerId: true },
    })
    expect(mockDb.emailJob.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ formId: "form-1", ownerId: "user-1" })],
    })
  })

  it("throws instead of enqueueing an owner-less job when the form is gone", async () => {
    mockDb.form.findUnique.mockResolvedValue(null)
    await expect(
      enqueueDigest({
        formId: "form-1",
        to: "owner@example.com",
        subject: "Digest",
        payload: {
          formName: "Contact us",
          count: 0,
          summary: "",
          highlights: [],
          items: [],
          inboxUrl: "http://localhost:3002/dashboard/inbox?formId=form-1",
          accentColor: "#0891b2",
          footerText: "",
        },
      })
    ).rejects.toThrow("Form form-1 not found.")
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })
})

describe("enqueueReply (DB-034)", () => {
  it("resolves the form's owner and stamps the created job with it", async () => {
    await enqueueReply({
      formId: "form-1",
      submissionId: "sub-1",
      to: "sara@example.com",
      subject: "Re: your message",
      body: "Hi Sara, thanks for writing.",
      formName: "Contact us",
    })
    expect(mockDb.form.findUnique).toHaveBeenCalledWith({
      where: { id: "form-1" },
      select: { ownerId: true },
    })
    expect(mockDb.emailJob.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ formId: "form-1", ownerId: "user-1" })],
    })
  })

  it("throws instead of enqueueing an owner-less job when the form is gone", async () => {
    mockDb.form.findUnique.mockResolvedValue(null)
    await expect(
      enqueueReply({
        formId: "form-1",
        submissionId: "sub-1",
        to: "sara@example.com",
        subject: "Re: your message",
        body: "Hi Sara, thanks for writing.",
        formName: "Contact us",
      })
    ).rejects.toThrow("Form form-1 not found.")
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })
})

describe("listEmailJobsForUser (DB-034)", () => {
  it("filters on ownerId directly, with no Form join for the owner", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([
      {
        id: "job-1",
        ownerId: "user-1",
        formId: "form-1",
        form: { name: "Contact us" },
      },
      {
        id: "job-2",
        ownerId: "user-1",
        formId: "form-2",
        form: { name: "Feedback" },
      },
    ])
    mockDb.emailJob.count.mockResolvedValue(2)
    const result = await listEmailJobsForUser("user-1", {})
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
    for (const call of [
      mockDb.emailJob.findMany.mock.calls[0][0],
      mockDb.emailJob.count.mock.calls[0][0],
      mockDb.emailJob.groupBy.mock.calls[0][0],
    ]) {
      const where = (call as { where: Record<string, unknown> }).where
      expect(where).toEqual({ ownerId: "user-1" })
      expect(where).not.toHaveProperty("form")
    }
  })

  it("keeps the status and formId filters alongside ownerId", async () => {
    await listEmailJobsForUser("user-1", {
      status: "PENDING",
      formId: "form-1",
    })
    const where = mockDb.emailJob.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >
    expect(where).toEqual({
      ownerId: "user-1",
      status: "PENDING",
      formId: "form-1",
    })
    expect(where).not.toHaveProperty("form")
    // The per-status counts keep owner + form, but never the status
    // filter itself (the counts are grouped by status).
    const groupWhere = mockDb.emailJob.groupBy.mock.calls[0][0].where as Record<
      string,
      unknown
    >
    expect(groupWhere).toEqual({ ownerId: "user-1", formId: "form-1" })
  })
})
