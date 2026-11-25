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
vi.mock("@sendcms/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/ai")>()
  // The real normalizeAiEnv stays live: the resolver normalizes the
  // env it is passed (SRC-123) before its legacy path reads it.
  return { ...actual, ...mockAi }
})
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
const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
// Phase 16 (EML-093): the model resolution is mocked so the
// AI-summary vs plain-digest branch is deterministic — the real
// resolver would read env/DB through the partial Prisma mock.
// The resolved type mirrors the real `resolveAiModelForUserSafe`
// contract (`ResolvedAiModel | null`): the fake model shape below
// stands in for a resolved model, and `null` means "no model
// resolves" (no provider configured / AI off for the owner).
const mockResolveAiModel = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      model: { modelId: string }
      provider: string
      modelId: string
      billingMode: string
    } | null> => ({
      model: { modelId: "test-model" },
      provider: "openai",
      modelId: "test-model",
      billingMode: "PLATFORM",
    })
  )
)
const mockRecordAiUsage = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/ai-settings", () => ({
  anyByokKeyConfigured: vi.fn(async () => false),
  recordAiUsage: mockRecordAiUsage,
  resolveAiModelForUserSafe: mockResolveAiModel,
}))

import { AuditResource } from "@sendcms/database"
import { sendDueDigests } from "@sendcms/submissions"

const ENV = { OPENAI_API_KEY: "sk-test" }

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    aiEnabled: true,
    // EML-093: the digest gate is this flag, not `aiEnabled`.
    digestEnabled: true,
    digestIntervalHours: null,
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
  // The default resolver outcome: a model resolves. Tests that need
  // "no model" override it per test — `mockResolvedValue` persists
  // across tests (clearAllMocks only clears calls), so the default
  // is re-established here every time.
  mockResolveAiModel.mockResolvedValue({
    model: { modelId: "test-model" },
    provider: "openai",
    modelId: "test-model",
    billingMode: "PLATFORM",
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

  it("still sends a plain digest when no AI provider is configured (EML-093)", async () => {
    mockAi.isAiConfigured.mockReturnValue(false)
    // "No provider configured" means no model resolves for the owner.
    mockResolveAiModel.mockResolvedValue(null)
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 1, skipped: 0 })
    // No model call — the digest is a notification, not an AI feature.
    expect(mockAi.generateDigest).not.toHaveBeenCalled()
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          summary: "1 new submission on Contact us.",
        }),
      })
    )
  })

  it("only asks for digest-enabled forms (EML-093)", async () => {
    await sendDueDigests({ env: ENV })
    expect(mockDb.form.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ digestEnabled: true }),
      })
    )
    expect(mockDb.form.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ aiEnabled: true }),
      })
    )
  })

  it("sends a plain digest when AI is off for the form (EML-093)", async () => {
    mockDb.form.findMany.mockResolvedValue([makeForm({ aiEnabled: false })])
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 1, skipped: 0 })
    expect(mockAi.generateDigest).not.toHaveBeenCalled()
    expect(mockResolveAiModel).not.toHaveBeenCalled()
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          summary: "1 new submission on Contact us.",
        }),
      })
    )
  })

  it("sends a plain digest when no model resolves for the owner (EML-093)", async () => {
    mockResolveAiModel.mockResolvedValue(null)
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 1, skipped: 0 })
    expect(mockAi.generateDigest).not.toHaveBeenCalled()
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          summary: "1 new submission on Contact us.",
        }),
      })
    )
  })

  it("skips a form whose digest is not due yet (per-form interval)", async () => {
    mockDb.form.findMany.mockResolvedValue([
      makeForm({
        lastDigestAt: new Date(Date.now() - 60 * 60 * 1000),
        digestIntervalHours: 168,
      }),
    ])
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 1 })
    expect(mockEnqueueDigest).not.toHaveBeenCalled()
    expect(mockDb.form.update).not.toHaveBeenCalled()
  })

  it("leaves the window alone when the enqueue creates no job (EML-093)", async () => {
    mockEnqueueDigest.mockResolvedValue(0)
    const result = await sendDueDigests({ env: ENV })
    expect(result).toEqual({ sent: 0, skipped: 1 })
    expect(mockDb.form.update).not.toHaveBeenCalled()
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

  it("writes one audit row per digest sent (AIM-029)", async () => {
    await sendDueDigests({ env: ENV })
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: AuditResource.FORM,
        resourceId: "form-1",
        detail: expect.objectContaining({
          // Renamed from `ai-digest-sent` in Phase 16 (EML-093):
          // plain digests carry no AI summary.
          event: "digest-sent",
          submissionCount: 1,
          aiSummary: true,
        }),
      })
    )
  })

  it("writes no audit row when no digest is sent (AIM-029)", async () => {
    mockDb.submission.findMany.mockResolvedValue([])
    await sendDueDigests({ env: ENV })
    expect(mockLogAudit).not.toHaveBeenCalled()
  })
})
