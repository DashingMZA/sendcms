// AI spam re-scoring (Phase 12, Step 2) with a mocked Prisma client
// and a mocked AI package. These pin the orchestration decisions —
// the live journey exercises the same paths against the dev DB with a
// real provider key.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  submissionEvent: { create: vi.fn() },
  aiDailyUsage: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockAi = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  getAiModel: vi.fn(() => ({ modelId: "test-model" })),
  getSpamThreshold: vi.fn(() => 70),
  rescoreSpam: vi.fn(async () => ({ score: 10, reason: "Genuine." })),
}))
vi.mock("@sendcms/ai", () => mockAi)
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@sendcms/platform-ops", () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}))
vi.mock("@sendcms/notifications", () => ({
  enqueueSubmissionNotifications: vi.fn(async () => 1),
}))
vi.mock("@sendcms/submissions/turnstile", () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}))

import { rescoreNewSubmissions } from "@sendcms/submissions"

const ENV = { OPENAI_API_KEY: "sk-test" }

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    data: { name: "Ali", message: "Hello, I need help." },
    status: "NEW",
    aiScoredAt: null,
    form: { id: "form-1", name: "Contact us" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockAi.isAiConfigured.mockReturnValue(true)
  mockAi.getSpamThreshold.mockReturnValue(70)
  mockAi.rescoreSpam.mockResolvedValue({ score: 10, reason: "Genuine." })
  mockDb.submission.findMany.mockResolvedValue([makeCandidate()])
  mockDb.aiDailyUsage.findUnique.mockResolvedValue(null)
  mockDb.aiDailyUsage.upsert.mockResolvedValue({ calls: 1 })
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      submission: { update: mockDb.submission.update },
      submissionEvent: { create: mockDb.submissionEvent.create },
    })
  )
})

describe("rescoreNewSubmissions", () => {
  it("does nothing when the ai-spam-rescore flag is off", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false)
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 0, markedSpam: 0, skipped: 0 })
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith("ai-spam-rescore")
    expect(mockDb.submission.findMany).not.toHaveBeenCalled()
    expect(mockAi.rescoreSpam).not.toHaveBeenCalled()
  })

  it("does nothing when no AI provider is configured", async () => {
    mockAi.isAiConfigured.mockReturnValue(false)
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 0, markedSpam: 0, skipped: 0 })
    expect(mockDb.submission.findMany).not.toHaveBeenCalled()
    expect(mockAi.rescoreSpam).not.toHaveBeenCalled()
  })

  it("only asks for NEW, unscored submissions on AI-enabled forms", async () => {
    await rescoreNewSubmissions({ env: ENV })
    expect(mockDb.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "NEW",
          aiScoredAt: null,
          form: { aiEnabled: true },
        }),
      })
    )
  })

  it("records a low score and leaves the submission NEW", async () => {
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 1, markedSpam: 0, skipped: 0 })
    expect(mockDb.submission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-1" },
        data: expect.objectContaining({ aiSpamScore: 10 }),
      })
    )
    expect(mockDb.submissionEvent.create).not.toHaveBeenCalled()
  })

  it("marks SPAM with an event when the score meets the threshold", async () => {
    mockAi.rescoreSpam.mockResolvedValue({
      score: 92,
      reason: "Unsolicited SEO link scheme.",
    })
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 1, markedSpam: 1, skipped: 0 })
    expect(mockDb.submission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SPAM", aiSpamScore: 92 }),
      })
    )
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          submissionId: "sub-1",
          type: "MARKED_SPAM",
          detail: expect.objectContaining({ source: "ai", score: 92 }),
        }),
      })
    )
  })

  it("skips a form whose daily AI cap is reached and never calls the model", async () => {
    mockDb.aiDailyUsage.findUnique.mockResolvedValue({ calls: 100 })
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 0, markedSpam: 0, skipped: 1 })
    expect(mockAi.rescoreSpam).not.toHaveBeenCalled()
    expect(mockDb.submission.update).not.toHaveBeenCalled()
  })

  it("skips a failed model call and keeps the submission unscored", async () => {
    mockAi.rescoreSpam.mockRejectedValue(new Error("provider down"))
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 0, markedSpam: 0, skipped: 1 })
    expect(mockDb.submission.update).not.toHaveBeenCalled()
  })

  it("increments the daily usage counter per scored submission", async () => {
    await rescoreNewSubmissions({ env: ENV })
    expect(mockDb.aiDailyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          formId_date: expect.objectContaining({ formId: "form-1" }),
        }),
        update: { calls: { increment: 1 } },
      })
    )
  })
})
