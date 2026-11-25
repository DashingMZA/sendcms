// Phase 16, Wave 8 — Stream A (Billing P1 core).
//
// Digest window (SRC-203 / DB-031): the 50-submission cap used to
// advance `lastDigestAt` to `now`, silently dropping every
// submission past the cap — the next run's `since` skipped them
// forever. Now the window advances to the createdAt of the last
// submission actually included, the digest carries a `truncated`
// flag + `totalCount`, and the next run picks up where the previous
// one stopped. Mocked Prisma client, AI package, and notifications
// module (same harness as tests/submission-digest.test.ts). No test
// hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  submission: {
    findMany: vi.fn(),
    // SRC-203: the whole-window count, read only when the 50-cap
    // was hit.
    count: vi.fn(async () => 0),
  },
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
    summary: "Summary.",
    highlights: [],
  })),
}))
vi.mock("@sendcms/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/ai")>()
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
vi.mock("@sendcms/ai-settings", () => ({
  anyByokKeyConfigured: vi.fn(async () => false),
  recordAiUsage: vi.fn(async () => {}),
  resolveAiModelForUserSafe: vi.fn(async () => null),
}))

import { sendDueDigests } from "@sendcms/submissions"

const ENV = { OPENAI_API_KEY: "test-key" }

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    aiEnabled: false,
    digestEnabled: true,
    digestIntervalHours: null,
    lastDigestAt: null,
    owner: { email: "owner@example.com" },
    ...overrides,
  }
}

function makeSubmission(i: number, base: Date) {
  return {
    id: `sub-${i}`,
    formId: "form-1",
    data: { name: `Sender ${i}`, message: `Message ${i}.` },
    status: "NEW",
    createdAt: new Date(base.getTime() + i * 1000),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockDb.form.findMany.mockResolvedValue([makeForm()])
  mockDb.form.update.mockResolvedValue({})
  mockDb.submission.findMany.mockResolvedValue([])
  mockDb.submission.count.mockResolvedValue(0)
})

describe("digest window past the 50-cap (SRC-203 / DB-031)", () => {
  it("advances the window to the last included submission, flags truncation, and counts the whole window", async () => {
    const base = new Date("2026-11-20T10:00:00Z")
    const first50 = Array.from({ length: 50 }, (_, i) =>
      makeSubmission(i + 1, base)
    )
    mockDb.submission.findMany.mockResolvedValue(first50)
    mockDb.submission.count.mockResolvedValue(60)

    const result = await sendDueDigests({ env: ENV })

    expect(result).toEqual({ sent: 1, skipped: 0 })
    // The window advances to the 50th submission's createdAt — NOT
    // `now` — so submissions 51-60 are still ahead of the cursor.
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "form-1" },
        data: { lastDigestAt: first50[49].createdAt },
      })
    )
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          count: 50,
          truncated: true,
          totalCount: 60,
        }),
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          event: "digest-sent",
          submissionCount: 50,
          truncated: true,
          totalCount: 60,
        }),
      })
    )
  })

  it("the next run covers submissions 51-60 (no silent drop)", async () => {
    const base = new Date("2026-11-20T10:00:00Z")
    const first50 = Array.from({ length: 50 }, (_, i) =>
      makeSubmission(i + 1, base)
    )
    mockDb.submission.findMany.mockResolvedValueOnce(first50)
    mockDb.submission.count.mockResolvedValueOnce(60)
    await sendDueDigests({ env: ENV })

    // Second run: the form's cursor is the 50th submission's time,
    // the window now holds submissions 51-60.
    const lastIncluded = first50[49].createdAt
    mockDb.form.findMany.mockResolvedValue([
      makeForm({ lastDigestAt: lastIncluded }),
    ])
    const rest = Array.from({ length: 10 }, (_, i) =>
      makeSubmission(51 + i, base)
    )
    mockDb.submission.findMany.mockResolvedValueOnce(rest)

    const result = await sendDueDigests({ env: ENV })

    expect(result).toEqual({ sent: 1, skipped: 0 })
    expect(mockDb.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gt: lastIncluded },
        }),
      })
    )
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          count: 10,
          truncated: false,
          totalCount: 10,
        }),
      })
    )
    // The cursor ends at the 60th submission — nothing is left
    // behind the window.
    expect(mockDb.form.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastDigestAt: rest[9].createdAt },
      })
    )
  })

  it("does not count the whole window when the cap was not hit", async () => {
    const base = new Date("2026-11-20T10:00:00Z")
    const three = Array.from({ length: 3 }, (_, i) =>
      makeSubmission(i + 1, base)
    )
    mockDb.submission.findMany.mockResolvedValue(three)

    await sendDueDigests({ env: ENV })

    expect(mockDb.submission.count).not.toHaveBeenCalled()
    expect(mockEnqueueDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          count: 3,
          truncated: false,
          totalCount: 3,
        }),
      })
    )
  })
})
