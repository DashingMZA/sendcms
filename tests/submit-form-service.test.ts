// submitForm service gates (SDK-016 / SDK-019) with a mocked Prisma
// client. The Turnstile ordering (token check before the server-secret
// check) and the rate-limit `retryAfterSeconds` on every 429 live in
// the service — the route only renders the header from the value.
// No test hits the real DB or the network (Turnstile verification is
// never reached: the 503 fail-closed fires before the fetch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  form: { findFirst: vi.fn() },
  submission: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockCheckLimitStrict = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true, limit: null, used: 0, remaining: null }))
)
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return {
    ...actual,
    checkLimitStrict: mockCheckLimitStrict,
    getEffectiveEntitlementsSafe: vi.fn(async () => null),
    recordUsageInTransaction: vi.fn(),
    startOfUtcMonth: () => new Date(Date.UTC(2026, 10, 1)),
  }
})
vi.mock("@sendcms/domains", () => ({
  normalizeDomain: (host: string) =>
    host
      .trim()
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, ""),
}))
vi.mock("@sendcms/ai", () => ({
  generateDigest: vi.fn(),
  getDigestIntervalHours: vi.fn(() => 24),
  getSpamThreshold: vi.fn(() => 0.7),
  isAiConfigured: vi.fn(() => false),
  rescoreSpam: vi.fn(),
}))
vi.mock("@sendcms/ai-settings", () => ({
  anyByokKeyConfigured: vi.fn(() => false),
  recordAiUsage: vi.fn(),
  resolveAiModelForUserSafe: vi.fn(async () => null),
}))
vi.mock("@sendcms/platform-ops", () => ({
  isFeatureEnabled: vi.fn(async () => false),
}))
vi.mock("@sendcms/notifications", () => ({
  enqueueDigest: vi.fn(),
  enqueueSubmissionNotifications: vi.fn(),
}))
vi.mock("@sendcms/security", () => ({ logAudit: vi.fn(async () => {}) }))

import { submitForm } from "@sendcms/submissions"
import { ApiError } from "@sendcms/api-client"

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    ownerId: "user-1",
    active: true,
    honeypotEnabled: false,
    turnstileEnabled: false,
    dailyLimit: null,
    successMessage: null,
    redirectUrl: null,
    fields: [
      {
        id: "field-1",
        formId: "form-1",
        name: "name",
        label: "Name",
        type: "TEXT",
        required: true,
        placeholder: null,
        options: null,
        minLength: null,
        maxLength: null,
        order: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    domainLinks: [{ domain: { domain: "sendcms.bond", status: "VERIFIED" } }],
    ...overrides,
  }
}

const META = {
  origin: "https://sendcms.bond",
  ip: "1.2.3.4",
  userAgent: "test",
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number
): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
    return err as ApiError
  }
  throw new Error("expected an ApiError")
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckLimitStrict.mockResolvedValue({
    allowed: true,
    limit: null,
    used: 0,
    remaining: null,
  })
  mockDb.form.findFirst.mockResolvedValue(makeForm())
  mockDb.submission.findUnique.mockResolvedValue(null)
  mockDb.submission.findFirst.mockResolvedValue(null)
  mockDb.submission.count.mockResolvedValue(0)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("submitForm — Turnstile ordering (SDK-016)", () => {
  const turnstileBody = {
    userId: "user-1",
    formId: "form-1",
    fields: { name: "Ali" },
  }

  it("fails closed with 422 (not 503) when the secret is unset and there is no token", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ turnstileEnabled: true })
    )
    const err = await expectApiError(submitForm(turnstileBody, META), 422)
    expect(err.message).toBe("Verification is required for this form.")
  })

  it("fails closed with 422 when the secret IS set and there is no token", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret")
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ turnstileEnabled: true })
    )
    const err = await expectApiError(submitForm(turnstileBody, META), 422)
    expect(err.message).toBe("Verification is required for this form.")
  })

  it("503s with the owner-worded message when a token is present but the secret is unset", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "")
    mockDb.form.findFirst.mockResolvedValue(
      makeForm({ turnstileEnabled: true })
    )
    const err = await expectApiError(
      submitForm({ ...turnstileBody, turnstileToken: "bogus-token" }, META),
      503
    )
    expect(err.message).toBe("Bot protection is not configured on this server.")
  })
})

describe("submitForm — rate-limit Retry-After (SDK-019)", () => {
  const body = {
    userId: "user-1",
    formId: "form-1",
    fields: { name: "Ali" },
  }

  it("minute-limit 429 carries retryAfterSeconds: 60", async () => {
    mockDb.submission.count.mockResolvedValueOnce(10)
    const err = await expectApiError(submitForm(body, META), 429)
    expect(err.message).toContain("wait a minute")
    expect(
      (err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds
    ).toBe(60)
    expect(err.originAllowed).toBe(true)
  })

  it("hour-limit 429 carries retryAfterSeconds: 3600", async () => {
    mockDb.submission.count.mockResolvedValueOnce(0).mockResolvedValueOnce(100)
    const err = await expectApiError(submitForm(body, META), 429)
    expect(
      (err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds
    ).toBe(3600)
  })

  it("daily-limit 429 carries seconds until midnight UTC", async () => {
    mockDb.form.findFirst.mockResolvedValue(makeForm({ dailyLimit: 5 }))
    mockDb.submission.count.mockResolvedValueOnce(5)
    const err = await expectApiError(submitForm(body, META), 429)
    const retryAfter = (err as ApiError & { retryAfterSeconds?: number })
      .retryAfterSeconds
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(86400)
  })
})
