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
vi.mock("@sendcms/notifications", () => ({
  enqueueSubmissionNotifications: vi.fn(async () => 1),
}))
vi.mock("@sendcms/submissions/turnstile", () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}))
const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))

import { AuditResource } from "@sendcms/database"
import { rescoreNewSubmissions } from "@sendcms/submissions"

const ENV = { OPENAI_API_KEY: "sk-test" }

// AIM-021: the claim runs inside a $transaction serialized by a
// Postgres advisory lock on (owner, day). The fake mirrors that
// guarantee — transaction callbacks run one at a time through a
// promise-chain mutex — and stores AiDailyUsage rows in a Map keyed
// `${formId}|${YYYY-MM-DD}`. The claim's decision logic (sum across
// the owner's forms, then increment) runs in the real code; the fake
// only provides the atomic store.
const usageStore = new Map<string, number>()
const ownerForms = new Map<string, string[]>([["user-1", ["form-1"]]])
let txQueue: Promise<void> = Promise.resolve()

function usageKey(formId: string, date: Date): string {
  return `${formId}|${date.toISOString().slice(0, 10)}`
}

function seedUsage(formId: string, calls: number, date = new Date()): void {
  usageStore.set(usageKey(formId, date), calls)
}

function totalUsage(formIds: string[], date = new Date()): number {
  const day = date.toISOString().slice(0, 10)
  return formIds.reduce(
    (sum, id) => sum + (usageStore.get(`${id}|${day}`) ?? 0),
    0
  )
}

function makeTx() {
  return {
    submission: { update: mockDb.submission.update },
    submissionEvent: { create: mockDb.submissionEvent.create },
    form: {
      findMany: vi.fn(async ({ where }: { where: { ownerId: string } }) =>
        (ownerForms.get(where.ownerId) ?? []).map((id) => ({ id }))
      ),
    },
    aiDailyUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { formId: { in: string[] }; date: Date }
        }) => {
          const day = where.date.toISOString().slice(0, 10)
          return where.formId.in
            .filter((id) => usageStore.has(`${id}|${day}`))
            .map((id) => ({ calls: usageStore.get(`${id}|${day}`) ?? 0 }))
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          update,
        }: {
          where: { formId_date: { formId: string; date: Date } }
          update: { calls: { increment: number } }
        }) => {
          const key = usageKey(where.formId_date.formId, where.formId_date.date)
          const next = (usageStore.get(key) ?? 0) + update.calls.increment
          usageStore.set(key, next)
          return { calls: next }
        }
      ),
    },
    $executeRaw: vi.fn(async () => []),
  }
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    data: { name: "Ali", message: "Hello, I need help." },
    status: "NEW",
    aiScoredAt: null,
    form: { id: "form-1", name: "Contact us", ownerId: "user-1" },
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
  usageStore.clear()
  ownerForms.set("user-1", ["form-1"])
  txQueue = Promise.resolve()
  mockDb.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
    const run = txQueue.then(() => cb(makeTx()))
    txQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  })
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
          form: { aiEnabled: true, deletedAt: null },
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

  it("skips an owner whose daily AI cap is reached and never calls the model", async () => {
    seedUsage("form-1", 100)
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

  it("a failed model call still consumes its claimed budget unit (AIM-021)", async () => {
    mockAi.rescoreSpam.mockRejectedValue(new Error("provider down"))
    await rescoreNewSubmissions({ env: ENV })
    expect(totalUsage(["form-1"])).toBe(1)
  })

  it("claims the budget unit before the model call (AIM-021)", async () => {
    await rescoreNewSubmissions({ env: ENV })
    expect(totalUsage(["form-1"])).toBe(1)
  })

  // AIM-021: the cap is per OWNER, not per form. An owner with two
  // AI-enabled forms gets the plan allowance once — 60 calls on one
  // form + 40 on the other exhausts a cap of 100, so the 101st
  // rescore across both forms is refused. (On the old per-form
  // counter both forms would each get 100.)
  it("caps the owner across forms, not per form", async () => {
    ownerForms.set("user-1", ["form-1", "form-2"])
    seedUsage("form-1", 60)
    seedUsage("form-2", 40)
    mockDb.submission.findMany.mockResolvedValue([
      makeCandidate({
        id: "sub-2",
        formId: "form-2",
        form: { id: "form-2", name: "Support", ownerId: "user-1" },
      }),
    ])
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 0, markedSpam: 0, skipped: 1 })
    expect(mockAi.rescoreSpam).not.toHaveBeenCalled()
    expect(totalUsage(["form-1", "form-2"])).toBe(100)
  })

  it("admits the 100th call across two forms", async () => {
    ownerForms.set("user-1", ["form-1", "form-2"])
    seedUsage("form-1", 60)
    seedUsage("form-2", 39)
    mockDb.submission.findMany.mockResolvedValue([
      makeCandidate({
        id: "sub-2",
        formId: "form-2",
        form: { id: "form-2", name: "Support", ownerId: "user-1" },
      }),
    ])
    const result = await rescoreNewSubmissions({ env: ENV })
    expect(result).toEqual({ checked: 1, markedSpam: 0, skipped: 0 })
    expect(totalUsage(["form-1", "form-2"])).toBe(100)
  })

  // AIM-021: two concurrent polls must not overshoot the cap. With
  // 99 of 100 units spent and two submissions to score, exactly one
  // model call happens across both runs and the counter lands on 100.
  // (On the old read-then-increment both runs would see 99 < 100 and
  // both spend a call.)
  it("two concurrent runs do not exceed the cap", async () => {
    ownerForms.set("user-1", ["form-1", "form-2"])
    seedUsage("form-1", 99)
    mockDb.submission.findMany.mockResolvedValue([
      makeCandidate(),
      makeCandidate({
        id: "sub-2",
        formId: "form-2",
        form: { id: "form-2", name: "Support", ownerId: "user-1" },
      }),
    ])
    const [first, second] = await Promise.all([
      rescoreNewSubmissions({ env: ENV }),
      rescoreNewSubmissions({ env: ENV }),
    ])
    expect(mockAi.rescoreSpam).toHaveBeenCalledTimes(1)
    expect(totalUsage(["form-1", "form-2"])).toBe(100)
    expect(first.checked + second.checked).toBe(1)
  })

  it("writes one audit row per touched form with the run counts (AIM-029)", async () => {
    await rescoreNewSubmissions({ env: ENV })
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: AuditResource.FORM,
        resourceId: "form-1",
        detail: expect.objectContaining({
          event: "ai-rescore-run",
          checked: 1,
          markedSpam: 0,
          skipped: 0,
        }),
      })
    )
  })

  it("audits a run that scores nothing as genuine (AIM-029)", async () => {
    seedUsage("form-1", 100)
    await rescoreNewSubmissions({ env: ENV })
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "form-1",
        detail: expect.objectContaining({
          event: "ai-rescore-run",
          checked: 0,
          markedSpam: 0,
          skipped: 1,
        }),
      })
    )
  })
})
