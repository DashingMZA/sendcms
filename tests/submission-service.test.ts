// submitForm decision tree (Phase 5 service) with a mocked Prisma client.
// These are the paths the live journeys exercise against the dev DB; the
// unit tests pin the same decisions without a database.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"

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
vi.mock("@/lib/services/email-outbox", () => ({
  enqueueSubmissionNotifications: vi.fn(async () => 1),
}))
vi.mock("@/lib/services/turnstile", () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}))

import { submitForm } from "@/lib/services/submission-service"
import type { SubmitResult } from "@/lib/services/submission-service"
import { enqueueSubmissionNotifications } from "@/lib/services/email-outbox"
import { verifyTurnstileToken } from "@/lib/services/turnstile"
import { ApiError } from "@/lib/api/error"

/** Narrows a non-honeypot result so `result.submission` typechecks. */
function submissionId(result: SubmitResult): string {
  if (result.kind === "honeypot") {
    throw new Error("expected a submission result, got honeypot")
  }
  return result.submission.id
}

const FIELDS = [
  { name: "name", label: "Name", type: "TEXT", required: true, order: 0 },
  { name: "email", label: "Email", type: "EMAIL", required: true, order: 1 },
  {
    name: "message",
    label: "Message",
    type: "TEXTAREA",
    required: true,
    order: 2,
  },
]

function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "form-1",
    ownerId: "user-1",
    active: true,
    honeypotEnabled: true,
    turnstileEnabled: false,
    dailyLimit: null,
    successMessage: "Thanks!",
    redirectUrl: null,
    fields: FIELDS,
    domainLinks: [{ domain: { domain: "example.com", status: "VERIFIED" } }],
    ...overrides,
  }
}

const BODY = {
  userId: "user-1",
  formId: "form-1",
  fields: { name: "Ali", email: "ali@example.com", message: "Hello" },
}
const META = {
  origin: "https://example.com/contact",
  ip: "1.2.3.4",
  userAgent: "test",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.form.findFirst.mockResolvedValue(makeForm())
  mockDb.submission.findUnique.mockResolvedValue(null)
  mockDb.submission.findFirst.mockResolvedValue(null)
  mockDb.submission.count.mockResolvedValue(0)
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      submission: {
        create: vi.fn(async () => ({ id: "sub-1" })),
      },
      submissionEvent: { create: vi.fn(async () => ({})) },
    })
  )
})

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  originAllowed?: boolean
) {
  try {
    await promise
    throw new Error("expected an ApiError")
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(status)
    if (originAllowed !== undefined) {
      expect((err as ApiError).originAllowed).toBe(originAllowed)
    }
  }
}

describe("submitForm", () => {
  it("creates a submission and enqueues notifications on the happy path", async () => {
    const result = await submitForm(BODY, META)
    expect(result.kind).toBe("created")
    expect(submissionId(result)).toBe("sub-1")
    expect(result.message).toBe("Thanks!")
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(enqueueSubmissionNotifications).toHaveBeenCalledWith(
      "form-1",
      "sub-1"
    )
  })

  it("saves the submission with status NEW and a CREATED event", async () => {
    let createdData: Record<string, unknown> | undefined
    let eventData: Record<string, unknown> | undefined
    mockDb.$transaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) =>
        cb({
          submission: {
            create: vi.fn(async (args: { data: Record<string, unknown> }) => {
              createdData = args.data
              return { id: "sub-1" }
            }),
          },
          submissionEvent: {
            create: vi.fn(async (args: { data: Record<string, unknown> }) => {
              eventData = args.data
              return {}
            }),
          },
        })
    )
    await submitForm(BODY, META)
    expect(createdData?.status).toBe("NEW")
    expect(createdData?.originDomain).toBe("example.com")
    expect(createdData?.data).toEqual({
      name: "Ali",
      email: "ali@example.com",
      message: "Hello",
    })
    expect(eventData?.type).toBe("CREATED")
  })

  it("throws 404 for an unknown form", async () => {
    mockDb.form.findFirst.mockResolvedValue(null)
    await expectApiError(submitForm(BODY, META), 404)
  })

  it("throws 403 for an inactive form", async () => {
    mockDb.form.findFirst.mockResolvedValue(makeForm({ active: false }))
    await expectApiError(submitForm(BODY, META), 403, true)
  })

  it("throws 403 for an unlinked origin and marks it not allowed", async () => {
    await expectApiError(
      submitForm(BODY, { ...META, origin: "https://evil.example" }),
      403,
      false
    )
  })

  it("throws 403 when there is no origin", async () => {
    await expectApiError(
      submitForm(BODY, { ...META, origin: null }),
      403,
      false
    )
  })

  it("returns a fake success and saves nothing when the honeypot is filled", async () => {
    const result = await submitForm({ ...BODY, _sendcms_honeypot: "bot" }, META)
    expect(result.kind).toBe("honeypot")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(enqueueSubmissionNotifications).not.toHaveBeenCalled()
  })

  it("throws 422 for an unknown field, a missing required field, and a bad email", async () => {
    await expectApiError(
      submitForm({ ...BODY, fields: { ...BODY.fields, extra: "x" } }, META),
      422
    )
    await expectApiError(
      submitForm({ ...BODY, fields: { email: "a@b.co", message: "hi" } }, META),
      422
    )
    await expectApiError(
      submitForm(
        {
          ...BODY,
          fields: { ...BODY.fields, email: "not-an-email" },
        },
        META
      ),
      422
    )
  })

  it("returns the original submission for a repeated idempotency key", async () => {
    mockDb.submission.findUnique.mockResolvedValue({ id: "sub-orig" })
    const result = await submitForm({ ...BODY, idempotencyKey: "key-1" }, META)
    expect(result.kind).toBe("duplicate")
    expect(submissionId(result)).toBe("sub-orig")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("returns the original submission for identical content within 10 minutes", async () => {
    mockDb.submission.findFirst.mockResolvedValue({ id: "sub-recent" })
    const result = await submitForm(BODY, META)
    expect(result.kind).toBe("duplicate")
    expect(submissionId(result)).toBe("sub-recent")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("throws 429 when the form daily limit is reached", async () => {
    mockDb.form.findFirst.mockResolvedValue(makeForm({ dailyLimit: 2 }))
    mockDb.submission.count.mockResolvedValue(2)
    await expectApiError(submitForm(BODY, META), 429)
  })

  it("throws 429 when the IP minute limit is reached", async () => {
    mockDb.submission.count.mockResolvedValue(10)
    await expectApiError(submitForm(BODY, META), 429)
  })

  it("saves spam as SPAM and does not enqueue notifications", async () => {
    let createdData: Record<string, unknown> | undefined
    mockDb.$transaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) =>
        cb({
          submission: {
            create: vi.fn(async (args: { data: Record<string, unknown> }) => {
              createdData = args.data
              return { id: "sub-1" }
            }),
          },
          submissionEvent: { create: vi.fn(async () => ({})) },
        })
    )
    const spamBody = {
      ...BODY,
      fields: {
        ...BODY.fields,
        message:
          "see https://a.example https://b.example https://c.example https://d.example",
      },
    }
    const result = await submitForm(spamBody, META)
    expect(result.kind).toBe("created")
    expect(createdData?.status).toBe("SPAM")
    expect(enqueueSubmissionNotifications).not.toHaveBeenCalled()
  })

  it("throws 413 when the sanitized payload exceeds 64 KB", async () => {
    const bigFields = Array.from({ length: 8 }, (_, i) => ({
      name: `f${i}`,
      label: `Field ${i}`,
      type: "TEXTAREA",
      required: false,
      order: i,
    }))
    mockDb.form.findFirst.mockResolvedValue(makeForm({ fields: bigFields }))
    const bigBody = {
      ...BODY,
      fields: Object.fromEntries(
        bigFields.map((f) => [f.name, "x".repeat(9000)])
      ),
    }
    await expectApiError(submitForm(bigBody, META), 413)
  })

  it("returns the original on an idempotency race (P2002 inside the transaction)", async () => {
    mockDb.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7",
      })
    )
    mockDb.submission.findUnique.mockResolvedValueOnce(null)
    mockDb.submission.findUnique.mockResolvedValueOnce({ id: "sub-race" })
    const result = await submitForm({ ...BODY, idempotencyKey: "k" }, META)
    expect(result.kind).toBe("duplicate")
    expect(submissionId(result)).toBe("sub-race")
  })

  describe("Turnstile", () => {
    it("throws 503 when enabled but no secret is configured", async () => {
      delete process.env.TURNSTILE_SECRET_KEY
      mockDb.form.findFirst.mockResolvedValue(
        makeForm({ turnstileEnabled: true })
      )
      await expectApiError(submitForm(BODY, META), 503)
    })

    it("throws 422 when enabled and the token is missing", async () => {
      process.env.TURNSTILE_SECRET_KEY = "secret"
      mockDb.form.findFirst.mockResolvedValue(
        makeForm({ turnstileEnabled: true })
      )
      await expectApiError(submitForm(BODY, META), 422)
    })

    it("throws 403 when verification fails and succeeds when it passes", async () => {
      process.env.TURNSTILE_SECRET_KEY = "secret"
      mockDb.form.findFirst.mockResolvedValue(
        makeForm({ turnstileEnabled: true })
      )
      vi.mocked(verifyTurnstileToken).mockResolvedValueOnce(false)
      await expectApiError(
        submitForm({ ...BODY, turnstileToken: "bad" }, META),
        403
      )
      vi.mocked(verifyTurnstileToken).mockResolvedValueOnce(true)
      const result = await submitForm({ ...BODY, turnstileToken: "ok" }, META)
      expect(result.kind).toBe("created")
    })
  })
})
