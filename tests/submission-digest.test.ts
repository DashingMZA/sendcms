// AI inbox digest (Phase 12, Step 3) with a mocked Prisma client, a
// mocked AI package, and a mocked notifications module. These pin the
// orchestration decisions — the live journey exercises the same paths
// against the dev DB with a real provider key.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  submission: { findMany: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockAi = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  getAiModel: vi.fn(() => ({ modelId: "test-model" })),
  getDigestIntervalHours: vi.fn(() => 24),
  generateDigest: vi.fn(async () => ({
    summary: "Two customers asked about orders.",
    highlights: ["Ali needs help with an order."],
  })),
}))
vi.mock("@sendcms/ai", () => mockAi)
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@sendcms/platform-ops", () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}))
const mockEnqueueDigest = vi.hoisted(() => vi.fn(async () => 1))
vi.mock("@sendcms/notifications", () => ({
  enqueueDigest: mockEnqueueDigest,
  enqueueSubmissionNotifications: vi.fn(async () => 1),
}))
vi.mock("@sendcms/submissions/turnstile", () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}))

import { sendDueDigests } from "@sendcms/submissions"

const ENV = { OPENAI_API_KEY: "sk-test" }

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    aiEnabled: true,
    lastDigestAt: null,
    owner: { email: "owner@example.com" },
    ...overrides,
  }
}

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    data: { name: "Ali", message: "I need help with my order." },
    status: "NEW",
    createdAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockAi.isAiConfigured.mockReturnValue(true)
  mockAi.getDigestIntervalHours.mockReturnValue(24)
  mockAi.generateDigest.mockResolvedValue({
    summary: "Two customers asked about orders.",
    highlights: ["Ali needs help with an order."],
  })
  mockDb.form.findMany.mockResolvedValue([makeForm()])
  mockDb.submission.findMany.mockResolvedValue([makeSubmission()])
  mockDb.form.update.mockResolvedValue(makeForm())
  mockEnqueueDigest.mockResolvedValue(1)
})

describe("sendDueDigests", () => {
  it("does nothing when the ai-digest flag is off", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false)
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 0 })
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith("ai-digest")
    expect(mockDb.form.findMany).not.toHaveBeenCalled()
    expect(mockAi.generateDigest).not.toHaveBeenCalled()
  })

  it("does nothing when no AI provider is configured", async () => {
    mockAi.isAiConfigured.mockReturnValue(false)
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 0 })
    expect(mockDb.form.findMany).not.toHaveBeenCalled()
    expect(mockAi.generateDigest).not.toHaveBeenCalled()
  })

  it("only asks for AI-enabled forms whose digest is due", async () => {
    await sendDueDigests({ env: ENV })
    expect(mockDb.form.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ aiEnabled: true }),
      })
    )
  })

  it("enqueues a digest to the form owner and advances the window", async () => {
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 1, skipped: 0 })
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: "form-1",
        to: "owner@example.com",
        subject: expect.stringContaining("1 new submission"),
        payload: expect.objectContaining({
          formName: "Contact us",
          count: 1,
          summary: "Two customers asked about orders.",
        }),
      })
    )
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "form-1" },
        data: expect.objectContaining({ lastDigestAt: expect.any(Date) }),
      })
    )
  })

  it("skips a form with no new submissions and leaves the window alone", async () => {
    mockDb.submission.findMany.mockResolvedValue([])
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 1 })
    expect(mockEnqueueDigest).not.toHaveBeenCalled()
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })

  it("skips a form when the model call fails and leaves the window alone", async () => {
    mockAi.generateDigest.mockRejectedValue(new Error("provider down"))
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 1 })
    expect(mockEnqueueDigest).not.toHaveBeenCalled()
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })

  it("only counts NEW submissions since the last digest", async () => {
    const lastDigestAt = new Date("2026-11-19T10:00:00Z")
    mockDb.form.findMany.mockResolvedValue([makeForm({ lastDigestAt })])
    await sendDueDigests({ env: ENV })
    expect(mockDb.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          formId: "form-1",
          status: "NEW",
          createdAt: { gt: lastDigestAt },
        }),
      })
    )
  })
})
