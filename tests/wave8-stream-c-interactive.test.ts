// Wave 8, Stream C — interactive AI routes (AIM-028 / AIM-004 /
// SRC-225 / DB-033): the daily budget caps suggest-fields and
// draft-reply, provider failures map to 502 without leaking key
// material, a bookkeeping failure never discards a good result,
// and the usage row carries the price-table cost.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetEffective = vi.hoisted(() => vi.fn())
const mockAi = vi.hoisted(() => ({
  isAiConfigured: vi.fn(() => true),
  getAiModel: vi.fn(() => ({ modelId: "gpt-4o-mini" })),
  suggestFields: vi.fn(
    async ({
      onUsage,
    }: {
      onUsage?: (u: {
        promptTokens: number
        completionTokens: number
        costMicros: number
      }) => void
    }) => {
      // The real @sendcms/ai suggestFields reports usage with cost
      // via toAiCallUsageWithCost — the mock reports the same shape:
      // 1000 in / 500 out on gpt-4o-mini = 450 micros.
      onUsage?.({ promptTokens: 1000, completionTokens: 500, costMicros: 450 })
      return {
        fields: [
          { name: "company", label: "Company", type: "TEXT", required: false },
        ],
      }
    }
  ),
  draftReply: vi.fn(
    async ({
      onUsage,
    }: {
      onUsage?: (u: {
        promptTokens: number
        completionTokens: number
        costMicros: number
      }) => void
    }) => {
      onUsage?.({ promptTokens: 1000, completionTokens: 500, costMicros: 450 })
      return { subject: "Re: your order", body: "Hi, thanks for writing." }
    }
  ),
}))

const { mockDb, usageRows } = vi.hoisted(() => {
  const counters = new Map<string, number>()
  const usageRows: Record<string, unknown>[] = []
  let chain: Promise<unknown> = Promise.resolve()
  function keyFor(table: string, id: string, date: Date): string {
    return `${table}:${id}:${date.toISOString().slice(0, 10)}`
  }
  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    form: {
      findFirst: vi.fn(),
      findMany: vi.fn(async ({ where }: { where: { ownerId: string } }) => [
        { id: `form-${where.ownerId.slice(-1)}` },
      ]),
    },
    submission: { findFirst: vi.fn() },
    aiDailyUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { formId: { in: string[] }; date: Date }
        }) =>
          where.formId.in
            .map(
              (id: string) => counters.get(keyFor("form", id, where.date)) ?? 0
            )
            .filter((c: number) => c > 0)
            .map((calls: number) => ({ calls }))
      ),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { formId_date: { formId: string; date: Date } }
        }) => {
          const key = keyFor(
            "form",
            where.formId_date.formId,
            where.formId_date.date
          )
          const next = (counters.get(key) ?? 0) + 1
          counters.set(key, next)
          return { calls: next }
        }
      ),
    },
    aiDailyOwnerUsage: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; date: Date } }) => {
          const calls =
            counters.get(keyFor("owner", where.userId, where.date)) ?? 0
          return calls > 0 ? [{ calls }] : []
        }
      ),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { userId_date: { userId: string; date: Date } }
        }) => {
          const key = keyFor(
            "owner",
            where.userId_date.userId,
            where.userId_date.date
          )
          const next = (counters.get(key) ?? 0) + 1
          counters.set(key, next)
          return { calls: next }
        }
      ),
    },
    aiUsageRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `usage-${usageRows.length + 1}`, ...data }
        usageRows.push(row)
        return row
      }),
    },
  }
  const mockDb = {
    ...tx,
    counters,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        status: "ACTIVE",
      })),
    },
    userAiSettings: { findUnique: vi.fn(async () => null) },
    userAiKey: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      chain = run.catch(() => undefined)
      return run
    }),
  }
  return { mockDb, usageRows }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/ai")>()
  return { ...actual, ...mockAi }
})
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock("@sendcms/observability", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))
vi.mock("@sendcms/notifications", () => ({
  enqueueReply: vi.fn(async () => {}),
}))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, getEffectiveEntitlementsSafe: mockGetEffective }
})

import type { EffectiveEntitlements } from "@sendcms/plans"
import { FREE_PLAN_V1_ENTITLEMENTS } from "@sendcms/plans/validators"
import { suggestFieldsForForm } from "@sendcms/forms"
import { draftReplyForSubmission } from "@sendcms/inbox"

const AI_ENV = { apiKeys: { openai: "sk-test" } }
const LONG_MESSAGE =
  "Hi, my order #48210 arrived damaged and I would like a replacement sent to the same address as soon as possible, please let me know the timeframe."

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    name: "Contact us",
    aiEnabled: true,
    fields: [
      { name: "name", label: "Name", type: "TEXT" },
      { name: "email", label: "Email", type: "EMAIL" },
    ],
    ...overrides,
  }
}

function makeSubmission() {
  return {
    id: "sub-1",
    formId: "form-2",
    data: {
      name: "Ali",
      email: "ali@example.com",
      message: LONG_MESSAGE,
    },
    status: "NEW",
    createdAt: new Date("2026-11-20T10:00:00Z"),
    form: { id: "form-2", name: "Contact us", aiEnabled: true },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.counters.clear()
  usageRows.length = 0
  mockGetEffective.mockResolvedValue({
    entitlements: { ...FREE_PLAN_V1_ENTITLEMENTS, aiRequestsPerDay: 2 },
    source: "free",
    planVersionId: null,
    emergency: false,
    overriddenMeters: [],
  } as EffectiveEntitlements)
  mockDb.form.findFirst.mockResolvedValue(makeForm())
  mockDb.submission.findFirst.mockResolvedValue(makeSubmission())
})

describe("suggestFieldsForForm — daily budget + error mapping", () => {
  it("refuses the 3rd call at cap 2 with 429 and writes no 3rd usage row", async () => {
    const first = await suggestFieldsForForm(
      "user-1",
      "form-1",
      "ask for the company too",
      AI_ENV
    )
    expect(first.fields).toHaveLength(1)
    await suggestFieldsForForm("user-1", "form-1", "ask again", AI_ENV)
    await expect(
      suggestFieldsForForm("user-1", "form-1", "ask a third time", AI_ENV)
    ).rejects.toMatchObject({ status: 429 })
    // The refused call never reached the model or the usage table.
    expect(mockAi.suggestFields).toHaveBeenCalledTimes(2)
    expect(usageRows).toHaveLength(2)
    expect(usageRows.every((r) => r.status === "SUCCESS")).toBe(true)
  })

  it("records the price-table cost on the usage row (DB-033)", async () => {
    await suggestFieldsForForm(
      "user-1",
      "form-1",
      "ask for the company",
      AI_ENV
    )
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0]).toMatchObject({
      provider: "OPENAI",
      model: "gpt-4o-mini",
      billingMode: "PLATFORM",
      status: "SUCCESS",
      tokensIn: 1000,
      tokensOut: 500,
      costMicros: 450,
      sourceEvent: "suggest-fields",
    })
  })

  it("maps a provider auth failure to 502 naming the provider, with no key material", async () => {
    mockAi.suggestFields.mockRejectedValueOnce(
      Object.assign(new Error("Incorrect API key provided: sk-test"), {
        statusCode: 401,
      })
    )
    let caught: unknown
    try {
      await suggestFieldsForForm(
        "user-1",
        "form-1",
        "ask for the company",
        AI_ENV
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ status: 502 })
    // Names the provider and points at AI settings; the provider's
    // raw message (which echoes key material) is never returned.
    expect((caught as Error).message).toContain("openai")
    expect((caught as Error).message).toContain("AI settings")
    expect((caught as Error).message).not.toContain("sk-test")
    // The failure is still recorded (FAILED row) — only the
    // client-facing error is mapped.
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0].status).toBe("FAILED")
  })

  it("returns the suggestions even when the usage write fails (SRC-225)", async () => {
    mockDb.aiUsageRecord.create.mockRejectedValueOnce(
      new Error("database down")
    )
    const result = await suggestFieldsForForm(
      "user-1",
      "form-1",
      "ask for the company",
      AI_ENV
    )
    expect(result.fields).toHaveLength(1)
  })
})

describe("draftReplyForSubmission — daily budget + excerpt (AIM-019)", () => {
  it("refuses the 3rd call at cap 2 with 429", async () => {
    await draftReplyForSubmission("user-2", "sub-1", AI_ENV)
    await draftReplyForSubmission("user-2", "sub-1", AI_ENV)
    await expect(
      draftReplyForSubmission("user-2", "sub-1", AI_ENV)
    ).rejects.toMatchObject({ status: 429 })
    expect(mockAi.draftReply).toHaveBeenCalledTimes(2)
  })

  it("hands the model the full message text, not the 80-char preview (AIM-019)", async () => {
    expect(LONG_MESSAGE.length).toBeGreaterThan(80)
    await draftReplyForSubmission("user-2", "sub-1", AI_ENV)
    const call = mockAi.draftReply.mock.calls[0][0] as {
      submission: { content: string }
    }
    expect(call.submission.content).toBe(LONG_MESSAGE)
  })
})
