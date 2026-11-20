// Auto-reply drafts (Phase 12, Step 4) with a mocked Prisma client, a
// mocked AI package, and a mocked notifications module. Pins the
// orchestration — the aiEnabled opt-in, the draft-only rule, and that
// the send enqueues the owner's own words (the model is never
// involved in the send).
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: { findFirst: vi.fn() },
  submissionEvent: { create: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockAi = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  getAiModel: vi.fn(() => ({ modelId: "test-model" })),
  draftReply: vi.fn(async () => ({
    subject: "Re: your order question",
    body: "Hi Ali, thanks for writing.",
  })),
}))
vi.mock("@sendcms/ai", () => mockAi)
const mockEnqueueReply = vi.hoisted(() => vi.fn(async () => 1))
vi.mock("@sendcms/notifications", () => ({
  enqueueReply: mockEnqueueReply,
}))
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))

import { draftReplyForSubmission, sendReplyToSubmission } from "@sendcms/inbox"

const ENV = { OPENAI_API_KEY: "sk-test" }

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    data: {
      name: "Ali",
      email: "ali@example.com",
      message: "Where is my order?",
    },
    status: "NEW",
    createdAt: new Date("2026-11-20T10:00:00Z"),
    form: { id: "form-1", name: "Contact us", aiEnabled: true },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAi.isAiConfigured.mockReturnValue(true)
  mockDb.submission.findFirst.mockResolvedValue(makeSubmission())
  mockAi.draftReply.mockResolvedValue({
    subject: "Re: your order question",
    body: "Hi Ali, thanks for writing.",
  })
  mockEnqueueReply.mockResolvedValue(1)
  mockDb.submissionEvent.create.mockResolvedValue({})
})

describe("draftReplyForSubmission", () => {
  it("returns the model's draft", async () => {
    const draft = await draftReplyForSubmission("user-1", "sub-1", ENV)
    expect(draft).toEqual({
      subject: "Re: your order question",
      body: "Hi Ali, thanks for writing.",
    })
    expect(mockAi.draftReply).toHaveBeenCalledWith(
      expect.objectContaining({ formName: "Contact us" })
    )
  })

  it("refuses when AI is off for the form", async () => {
    mockDb.submission.findFirst.mockResolvedValue(
      makeSubmission({
        form: { id: "form-1", name: "Contact us", aiEnabled: false },
      })
    )
    await expect(
      draftReplyForSubmission("user-1", "sub-1", ENV)
    ).rejects.toMatchObject({
      status: 403,
    })
    expect(mockAi.draftReply).not.toHaveBeenCalled()
  })

  it("refuses with 503 when no provider is configured", async () => {
    mockAi.isAiConfigured.mockReturnValue(false)
    await expect(
      draftReplyForSubmission("user-1", "sub-1", ENV)
    ).rejects.toMatchObject({
      status: 503,
    })
    expect(mockAi.draftReply).not.toHaveBeenCalled()
  })

  it("throws 404 for a submission the user does not own", async () => {
    mockDb.submission.findFirst.mockResolvedValue(null)
    await expect(
      draftReplyForSubmission("user-1", "sub-1", ENV)
    ).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe("sendReplyToSubmission", () => {
  it("enqueues the owner's words to the sender and records the event", async () => {
    const result = await sendReplyToSubmission("user-1", "sub-1", {
      subject: "Re: your order",
      body: "Hi Ali, your order is on its way.",
    })
    expect(result).toEqual({ enqueued: 1 })
    expect(mockEnqueueReply).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: "form-1",
        submissionId: "sub-1",
        to: "ali@example.com",
        subject: "Re: your order",
        body: "Hi Ali, your order is on its way.",
      })
    )
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          submissionId: "sub-1",
          detail: { reply: true },
        }),
      })
    )
    // The model is never involved in the send.
    expect(mockAi.draftReply).not.toHaveBeenCalled()
  })

  it("refuses when the submission has no email address", async () => {
    mockDb.submission.findFirst.mockResolvedValue(
      makeSubmission({ data: { name: "Ali", message: "Where is my order?" } })
    )
    await expect(
      sendReplyToSubmission("user-1", "sub-1", { subject: "Hi", body: "Hi" })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockEnqueueReply).not.toHaveBeenCalled()
  })

  it("refuses an empty subject or body", async () => {
    await expect(
      sendReplyToSubmission("user-1", "sub-1", { subject: "  ", body: "Hi" })
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      sendReplyToSubmission("user-1", "sub-1", { subject: "Hi", body: "" })
    ).rejects.toMatchObject({ status: 422 })
    expect(mockEnqueueReply).not.toHaveBeenCalled()
  })
})
