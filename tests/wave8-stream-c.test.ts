// Wave 8, Stream C (AI / BYOK / MCP) regression tests.
//
// Covers: ADM-063 (RETRY bucket), ADM-065 (full models aggregate),
// AIM-003/004/019/023/025/026, DB-018 (unit map), DB-033 (cost),
// SRC-218 (claim concurrency), SRC-310 (UTC windows), SRC-314
// (BYOK rotation), SRC-323/332 (MCP usage), SRC-325 (provider
// resolution + input caps).
import { readFileSync } from "node:fs"
import { describe, expect, it, vi, beforeEach } from "vitest"

const mockGenerateObject = vi.hoisted(() => vi.fn())
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateObject: mockGenerateObject }
})

import {
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_RETRIES,
  DEFAULT_MODELS,
  MODEL_PRICES_USD_PER_MILLION_TOKENS,
  classifyAiCallError,
  decryptByokKey,
  encryptByokKey,
  estimateAiCallCostMicros,
  getLanguageModelId,
  isAiAuthFailure,
  mapAiCallError,
  reencryptByokKey,
  rescoreSpam,
  resolveAiProvider,
  toAiCallUsageWithCost,
  truncateAiInput,
  AI_MAX_SUBMISSION_CHARS,
} from "@sendcms/ai"
import { aiSubmissionExcerpt } from "@sendcms/shared"
import {
  MCP_TOOL_NAMES,
  isToolAvailableForScope,
  startOfUtcHour,
  startOfUtcMinute,
  toolsForScope,
} from "@sendcms/mcp"
import { SaveAiKeySchema } from "@sendcms/ai-settings/validators"
import { McpKeysListQuerySchema } from "@sendcms/mcp-admin/validators"
import { UNIT_BY_METER, assertUsageUnit } from "@sendcms/plans"
import { ApiError } from "@sendcms/shared"

const fakeModel = { modelId: "test-model" } as never

describe("error mapping (AIM-004 / AIM-023 / SRC-225)", () => {
  it("maps a 401 provider error to a 502 naming the provider, with AI-settings guidance", () => {
    const err = mapAiCallError(
      Object.assign(new Error("Incorrect API key provided: sk-xxxx"), {
        statusCode: 401,
      }),
      "openai"
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.message).toContain("openai")
    expect(err.message).toContain("AI settings")
    // AIM-006: the provider's raw message (which can echo key
    // material) is never returned.
    expect(err.message).not.toContain("sk-xxxx")
  })

  it("maps 429 to 429, overload/timeout to 503, and a missing model to 502", () => {
    expect(
      classifyAiCallError(Object.assign(new Error("x"), { statusCode: 429 }))
    ).toEqual({ kind: "rate-limit", status: 429 })
    expect(
      classifyAiCallError(Object.assign(new Error("x"), { statusCode: 503 }))
    ).toEqual({ kind: "overloaded", status: 503 })
    const timeout = new Error("The operation timed out")
    timeout.name = "AbortError"
    expect(classifyAiCallError(timeout)).toEqual({
      kind: "timeout",
      status: 503,
    })
    expect(
      classifyAiCallError(Object.assign(new Error("x"), { statusCode: 404 }))
    ).toEqual({ kind: "not-found", status: 502 })
    // A plain unknown error is a generic provider 502 — never a 500
    // that looks like a server bug, and never the raw message.
    const mapped = mapAiCallError(new Error("boom"), "google")
    expect(mapped.status).toBe(502)
    expect(mapped.message).not.toContain("boom")
  })

  it("only auth failures count for BYOK auto-disable (AIM-003)", () => {
    expect(
      isAiAuthFailure(Object.assign(new Error("x"), { statusCode: 401 }))
    ).toBe(true)
    expect(
      isAiAuthFailure(Object.assign(new Error("x"), { statusCode: 429 }))
    ).toBe(false)
    const timeout = new Error("timed out")
    timeout.name = "TimeoutError"
    expect(isAiAuthFailure(timeout)).toBe(false)
    expect(
      isAiAuthFailure(Object.assign(new Error("x"), { statusCode: 500 }))
    ).toBe(false)
  })
})

describe("cost attribution (DB-033)", () => {
  it("prices a known model from provider-reported tokens", () => {
    // gpt-4o-mini: $0.15 in / $0.60 out per 1M tokens.
    // 1,000,000 in + 1,000,000 out = $0.75 = 750,000 micros.
    expect(estimateAiCallCostMicros("gpt-4o-mini", 1_000_000, 1_000_000)).toBe(
      750_000
    )
    expect(estimateAiCallCostMicros("gpt-4o-mini", 1000, 500)).toBe(450)
  })

  it("returns null — never an estimate — for an unknown model or missing tokens", () => {
    expect(estimateAiCallCostMicros("future-model-9", 1000, 500)).toBeNull()
    expect(estimateAiCallCostMicros(null, 1000, 500)).toBeNull()
    expect(estimateAiCallCostMicros("gpt-4o-mini", null, 500)).toBeNull()
  })

  it("attaches cost to usage, null for an unpriced test model", () => {
    const usage = toAiCallUsageWithCost("gpt-4o-mini", {
      inputTokens: 1000,
      outputTokens: 500,
    })
    expect(usage?.costMicros).toBe(450)
    expect(
      toAiCallUsageWithCost("test-model", {
        inputTokens: 1000,
        outputTokens: 500,
      })?.costMicros
    ).toBeNull()
  })

  it("every default model has a price row (drift guard)", () => {
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(
        MODEL_PRICES_USD_PER_MILLION_TOKENS[model],
        `${model} is a default model but has no price row`
      ).toBeDefined()
    }
  })

  it("getLanguageModelId reads the id structurally, null for a bare test double", () => {
    expect(getLanguageModelId({ modelId: "gpt-4o-mini" } as never)).toBe(
      "gpt-4o-mini"
    )
    expect(getLanguageModelId({} as never)).toBeNull()
  })
})

describe("input caps (SRC-325 / AIM-019)", () => {
  it("truncates a 100KB submission to the 8000-char cap", () => {
    const big = "x".repeat(100_000)
    const cut = truncateAiInput(big, AI_MAX_SUBMISSION_CHARS)
    expect(cut.length).toBe(AI_MAX_SUBMISSION_CHARS + 1) // + "…"
    expect(cut.endsWith("…")).toBe(true)
    expect(truncateAiInput("short", AI_MAX_SUBMISSION_CHARS)).toBe("short")
  })

  it("aiSubmissionExcerpt returns the full message text, not the 80-char UI preview", () => {
    const message =
      "Hi, my order #48210 arrived damaged and I would like a replacement sent to the same address as soon as possible, please."
    expect(message.length).toBeGreaterThan(80)
    const excerpt = aiSubmissionExcerpt(
      { name: "Ali", email: "ali@example.com", message },
      2000
    )
    expect(excerpt).toBe(message)
    // The digest budget is smaller — still far more than 80 chars.
    expect(aiSubmissionExcerpt({ message }, 500)).toBe(message)
  })

  it("provider resolution is case-insensitive and documents its precedence", () => {
    expect(resolveAiProvider({ AI_PROVIDER: "Google" } as never)).toBe("google")
    expect(resolveAiProvider({ AI_PROVIDER: "  OPENAI " } as never)).toBe(
      "openai"
    )
    // No explicit provider: first key set wins, in AI_PROVIDERS order.
    expect(
      resolveAiProvider({ DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: "y" } as never)
    ).toBe("openai")
    expect(resolveAiProvider({} as never)).toBe("none")
    expect(() =>
      resolveAiProvider({ AI_PROVIDER: "not-a-provider" } as never)
    ).toThrow(/Unknown AI_PROVIDER/)
  })
})

describe("spam prompt (AIM-026) + call bounds (SRC-311 / AIM-023)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateObject.mockResolvedValue({
      object: { score: 10, reason: "Looks genuine." },
    })
  })

  it("tells the model not to copy submission content into the reason", async () => {
    await rescoreSpam({
      model: fakeModel,
      formName: "Contact us",
      data: { name: "Ali", message: "Where is my order?" },
    })
    const call = mockGenerateObject.mock.calls[0][0] as { prompt: string }
    expect(call.prompt).toContain(
      "Do not copy any submission content into the reason."
    )
  })

  it("bounds the call: timeout signal, one retry, 300 output tokens", async () => {
    await rescoreSpam({
      model: fakeModel,
      formName: "Contact us",
      data: { message: "hi" },
      timeoutMs: 1234,
    })
    const call = mockGenerateObject.mock.calls[0][0] as {
      abortSignal?: AbortSignal
      maxRetries?: number
      maxOutputTokens?: number
    }
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
    expect(call.maxRetries).toBe(AI_MAX_RETRIES)
    expect(call.maxRetries).toBe(1)
    expect(call.maxOutputTokens).toBe(AI_MAX_OUTPUT_TOKENS.spam)
    expect(call.maxOutputTokens).toBe(300)
  })
})

describe("UTC rate-limit windows (SRC-310)", () => {
  it("buckets by UTC minute/hour regardless of the runner's timezone", () => {
    // The assertion itself is UTC (toISOString) — it must not depend
    // on the runner's TZ. 10:30:45 UTC is 03:30 local in Los Angeles
    // in winter: the old local-time code bucketed it as 03:30.
    const at = new Date("2026-11-25T10:30:45.123Z")
    expect(startOfUtcMinute(at).toISOString()).toBe("2026-11-25T10:30:00.000Z")
    expect(startOfUtcHour(at).toISOString()).toBe("2026-11-25T10:00:00.000Z")
    // A minute boundary in UTC is a boundary in every timezone.
    expect(
      startOfUtcMinute(new Date("2026-11-25T10:31:00.000Z")).toISOString()
    ).toBe("2026-11-25T10:31:00.000Z")
  })
})

describe("MCP scope tools (AIM-008)", () => {
  it("READ scope gets the 9 read tools only; FULL gets all 19", () => {
    expect(toolsForScope("READ")).toHaveLength(9)
    expect(toolsForScope("FULL")).toHaveLength(19)
    expect(toolsForScope("READ")).not.toContain("create_form")
    expect(toolsForScope("FULL")).toContain("create_form")
    expect(isToolAvailableForScope("READ", "list_domains")).toBe(true)
    expect(isToolAvailableForScope("READ", "create_form")).toBe(false)
    expect(isToolAvailableForScope("FULL", "create_form")).toBe(true)
    expect(isToolAvailableForScope("READ", "no_such_tool")).toBe(false)
  })

  it("the tool CHECK in the migration lists exactly the 19 tool names (drift guard, DB-018)", () => {
    expect(MCP_TOOL_NAMES).toHaveLength(19)
    const sql = readFileSync(
      "packages/database/prisma/migrations/20261125094500_wave8c_stream_c/migration.sql",
      "utf8"
    )
    for (const tool of MCP_TOOL_NAMES) {
      expect(sql, `migration CHECK is missing tool ${tool}`).toContain(
        `'${tool}'`
      )
    }
  })
})

describe("BYOK key rotation (SRC-314)", () => {
  const V1 = "aa".repeat(32) // 64 hex chars = 32 bytes
  const V2 = "bb".repeat(32)

  beforeEach(() => {
    vi.stubEnv("AI_BYOK_MASTER_KEY", V1)
    vi.unstubAllEnvs()
    vi.stubEnv("AI_BYOK_MASTER_KEY", V1)
  })

  it("encrypts under v1, decrypts after rotating the env to v2, and re-encrypts under v2", () => {
    const row = encryptByokKey("sk-test-key", {
      userId: "user-1",
      provider: "openai",
    })
    expect(row.masterKeyVersion).toBe(1)
    // Rotation step 1: the owner adds V2 (V1 stays for old rows).
    vi.stubEnv("AI_BYOK_MASTER_KEY_V2", V2)
    // The row still decrypts — the version stamped on it selects V1.
    expect(
      decryptByokKey({ userId: "user-1", provider: "openai", ...row })
    ).toBe("sk-test-key")
    // Rotation step 3: re-encryption moves the row to V2, same value.
    const rotated = reencryptByokKey({
      userId: "user-1",
      provider: "openai",
      ...row,
    })
    expect(rotated.masterKeyVersion).toBe(2)
    expect(
      decryptByokKey({ userId: "user-1", provider: "openai", ...rotated })
    ).toBe("sk-test-key")
  })

  it("fails loudly for a row stamped with an unknown version", () => {
    const row = encryptByokKey("sk-test-key", {
      userId: "user-1",
      provider: "openai",
    })
    expect(() =>
      decryptByokKey({
        userId: "user-1",
        provider: "openai",
        ...row,
        masterKeyVersion: 99,
      })
    ).toThrow()
  })
})

describe("validators (AIM-025 / ADM-064 / DB-018)", () => {
  it("SaveAiKeySchema accepts the terms acknowledgement flag", () => {
    const parsed = SaveAiKeySchema.parse({
      provider: "openai",
      apiKey: "sk-test-key-123",
      termsAcknowledged: true,
    })
    expect(parsed.termsAcknowledged).toBe(true)
    // Still optional for callers that do not save on the server
    // (browser-only saves never reach this schema).
    expect(
      SaveAiKeySchema.parse({ provider: "openai", apiKey: "sk-test-key-123" })
        .termsAcknowledged
    ).toBeUndefined()
  })

  it("McpKeysListQuerySchema parses search/scope/revoked filters", () => {
    const parsed = McpKeysListQuerySchema.parse({
      page: "2",
      search: "alice",
      scope: "READ",
      revoked: "true",
    })
    expect(parsed.page).toBe(2)
    expect(parsed.search).toBe("alice")
    expect(parsed.scope).toBe("READ")
    expect(parsed.revoked).toBe(true)
    expect(McpKeysListQuerySchema.parse({ revoked: "false" }).revoked).toBe(
      false
    )
    expect(() => McpKeysListQuerySchema.parse({ scope: "ADMIN" })).toThrow()
  })

  it("the usage unit is implied by the meter and enforced (DB-018)", () => {
    expect(UNIT_BY_METER).toEqual({
      FORMS: "form",
      DOMAINS: "domain",
      SUBMISSIONS: "submission",
      API_KEYS: "api-key",
      MCP_REQUESTS: "request",
      AI_REQUESTS: "request",
    })
    expect(() => assertUsageUnit("SUBMISSIONS", "submission")).not.toThrow()
    expect(() => assertUsageUnit("SUBMISSIONS", "form")).toThrow(
      /Invalid unit "form" for meter SUBMISSIONS/
    )
    expect(() => assertUsageUnit("AI_REQUESTS", "submission")).toThrow(
      /Invalid unit/
    )
  })
})

// ─── Summary + claim tests (mocked DB) ────────────────────────────────────

const mockDb = vi.hoisted(() => {
  // Stateful daily counters, keyed "form:<formId>:<date>" /
  // "owner:<userId>:<date>".
  const counters = new Map<string, number>()
  // Serializes $transaction callbacks — the in-test stand-in for
  // the advisory lock: two concurrent claims run one at a time,
  // exactly like two transactions waiting on pg_advisory_xact_lock.
  let chain: Promise<unknown> = Promise.resolve()
  function keyFor(table: "form" | "owner", id: string, date: Date): string {
    return `${table}:${id}:${date.toISOString().slice(0, 10)}`
  }
  function readRows(
    table: "form" | "owner",
    ids: string[],
    date: Date
  ): { calls: number }[] {
    return ids
      .map((id) => counters.get(keyFor(table, id, date)) ?? 0)
      .filter((calls) => calls > 0)
      .map((calls) => ({ calls }))
  }
  function bump(
    table: "form" | "owner",
    id: string,
    date: Date
  ): { calls: number } {
    const key = keyFor(table, id, date)
    const next = (counters.get(key) ?? 0) + 1
    counters.set(key, next)
    return { calls: next }
  }
  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    form: {
      // The claim reads the owner's forms to sum their counters —
      // each test user owns exactly the one form it claims on.
      findMany: vi.fn(async ({ where }: { where: { ownerId: string } }) => [
        { id: `form-${where.ownerId.slice(-1)}` },
      ]),
    },
    aiDailyUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { formId: { in: string[] }; date: Date }
        }) => readRows("form", where.formId.in, where.date)
      ),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { formId_date: { formId: string; date: Date } }
        }) => bump("form", where.formId_date.formId, where.formId_date.date)
      ),
    },
    aiDailyOwnerUsage: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; date: Date } }) =>
          readRows("owner", [where.userId], where.date)
      ),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { userId_date: { userId: string; date: Date } }
        }) => bump("owner", where.userId_date.userId, where.userId_date.date)
      ),
    },
  }
  return {
    ...tx,
    counters,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      // Keep the chain alive past a rejection so later claims still run.
      chain = run.catch(() => undefined)
      return run
    }),
    aiUsageRecord: {
      groupBy: vi.fn(async ({ by }: { by: string[] }) => {
        if (by.join(",") === "billingMode,status") {
          return [
            {
              billingMode: "BYOK",
              status: "SUCCESS",
              _count: { _all: 1 },
              _sum: { tokensIn: 5, tokensOut: 1, costMicros: 450 },
            },
            {
              billingMode: "BYOK",
              status: "RETRY",
              _count: { _all: 2 },
              _sum: { tokensIn: 0, tokensOut: 0, costMicros: 0 },
            },
            {
              billingMode: "PLATFORM",
              status: "SUCCESS",
              _count: { _all: 1 },
              _sum: { tokensIn: 10, tokensOut: 2, costMicros: 900 },
            },
            {
              billingMode: "PLATFORM",
              status: "FAILED",
              _count: { _all: 1 },
              _sum: { tokensIn: 0, tokensOut: 0, costMicros: 0 },
            },
          ]
        }
        // provider,model,status — 101 rows across two models.
        return [
          {
            provider: "OPENAI",
            model: "gpt-4o-mini",
            status: "SUCCESS",
            _count: { _all: 60 },
          },
          {
            provider: "OPENAI",
            model: "gpt-4o-mini",
            status: "RETRY",
            _count: { _all: 40 },
          },
          {
            provider: "GOOGLE",
            model: "gemini-3.5-flash-lite",
            status: "SUCCESS",
            _count: { _all: 1 },
          },
        ]
      }),
    },
  }
})
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))

import type { AdminSession } from "@sendcms/auth"
import { claimAiCall, getAiUsageSummary } from "@sendcms/ai-settings"

function makeSession(): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

describe("usage summary (ADM-063 / ADM-065)", () => {
  it("counts RETRY separately and keeps success + failed + retry === calls", async () => {
    const summary = await getAiUsageSummary(makeSession(), {})
    expect(summary.byok).toMatchObject({
      calls: 3,
      success: 1,
      failed: 0,
      retry: 2,
    })
    expect(summary.platform).toMatchObject({
      calls: 2,
      success: 1,
      failed: 1,
      retry: 0,
    })
    expect(summary.total).toMatchObject({
      calls: 5,
      success: 2,
      failed: 1,
      retry: 2,
    })
    expect(
      summary.total.success + summary.total.failed + summary.total.retry
    ).toBe(summary.total.calls)
  })

  it("lists every model with full counts — 101 rows across 2 models, not a 100-row sample", async () => {
    const summary = await getAiUsageSummary(makeSession(), {})
    expect(summary.models).toHaveLength(2)
    expect(summary.models[0]).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      calls: 100,
      success: 60,
      failed: 0,
      retry: 40,
    })
    expect(summary.models[1]).toEqual({
      provider: "google",
      model: "gemini-3.5-flash-lite",
      calls: 1,
      success: 1,
      failed: 0,
      retry: 0,
    })
  })
})

describe("daily-budget claim (SRC-218)", () => {
  it("admits exactly one of two concurrent rescores at cap 1", async () => {
    const today = new Date("2026-11-25T00:00:00.000Z")
    const [first, second] = await Promise.all([
      claimAiCall("user-1", { formId: "form-1", cap: 1, today }),
      claimAiCall("user-1", { formId: "form-1", cap: 1, today }),
    ])
    // One claim wins, the other sees the spent unit — the counter
    // advances by exactly 1, never 2.
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(mockDb.counters.get("form:form-1:2026-11-25")).toBe(1)
  })

  it("admits up to the cap, then refuses without spending", async () => {
    const today = new Date("2026-11-25T00:00:00.000Z")
    expect(
      await claimAiCall("user-2", { formId: "form-2", cap: 2, today })
    ).toBe(true)
    expect(
      await claimAiCall("user-2", { formId: "form-2", cap: 2, today })
    ).toBe(true)
    expect(
      await claimAiCall("user-2", { formId: "form-2", cap: 2, today })
    ).toBe(false)
    expect(mockDb.counters.get("form:form-2:2026-11-25")).toBe(2)
  })

  it("a cap of 0 admits nothing", async () => {
    expect(
      await claimAiCall("user-3", {
        formId: "form-3",
        cap: 0,
        today: new Date("2026-11-25T00:00:00.000Z"),
      })
    ).toBe(false)
  })
})
