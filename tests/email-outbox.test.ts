import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@react-email/render"
import {
  SubmissionNotification,
  resolveEmailProvider,
  sendPlatformEmail,
  submissionNotificationText,
} from "@sendcms/email"
import { buildSubmissionNotificationSubject } from "@sendcms/notifications"
import {
  EmailJobListQuerySchema,
  TestEmailSchema,
} from "@sendcms/notifications/validators"

const ENV_KEYS = [
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

describe("resolveEmailProvider", () => {
  it("prefers Resend when its key is set", () => {
    process.env.RESEND_API_KEY = "re_test"
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_USER = "user@example.com"
    process.env.SMTP_PASS = "secret"
    expect(resolveEmailProvider()).toBe("resend")
  })

  it("falls back to SMTP when only SMTP is configured", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_USER = "user@example.com"
    process.env.SMTP_PASS = "secret"
    expect(resolveEmailProvider()).toBe("smtp")
  })

  it("returns none when nothing is configured", () => {
    expect(resolveEmailProvider()).toBe("none")
  })
})

describe("sendPlatformEmail", () => {
  it("throws a clear error with no provider", async () => {
    await expect(
      sendPlatformEmail({ to: "a@b.co", subject: "hi", html: "<p>hi</p>" })
    ).rejects.toThrow("No email provider configured")
  })

  it("sends via Resend and returns its message id", async () => {
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-1" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const result = await sendPlatformEmail({
      to: "a@b.co",
      subject: "hi",
      html: "<p>hi</p>",
    })
    expect(result).toEqual({ messageId: "resend-msg-1", provider: "resend" })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.to).toEqual(["a@b.co"])
    expect(body.subject).toBe("hi")
  })

  it("surfaces Resend's error message", async () => {
    process.env.RESEND_API_KEY = "re_bad"
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: async () => ({ message: "Domain not verified" }),
      })
    )
    await expect(
      sendPlatformEmail({ to: "a@b.co", subject: "hi", html: "<p>hi</p>" })
    ).rejects.toThrow("Domain not verified")
  })
})

describe("buildSubmissionNotificationSubject", () => {
  it("names the sender when known", () => {
    expect(buildSubmissionNotificationSubject("Contact", "Ali")).toBe(
      "New submission from Ali on Contact"
    )
    expect(buildSubmissionNotificationSubject("Contact", null)).toBe(
      "New submission on Contact"
    )
  })
})

describe("SubmissionNotification template", () => {
  const props = {
    formName: "Contact",
    senderName: "Ali",
    senderEmail: "ali@example.com",
    fields: [
      { label: "name", value: "Ali" },
      { label: "message", value: "Hello there" },
    ],
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    receivedAt: new Date("2026-11-17T10:00:00Z"),
    inboxUrl: "http://localhost:3000/dashboard/inbox/abc",
    accentColor: "#0891b2",
    footerText: "Test footer.",
  }

  it("renders sender, fields, page and inbox link", async () => {
    const html = await render(SubmissionNotification(props))
    expect(html).toContain("New submission on Contact")
    expect(html).toContain("Ali")
    expect(html).toContain("ali@example.com")
    expect(html).toContain("Hello there")
    expect(html).toContain("https://example.com/contact")
    expect(html).toContain("http://localhost:3000/dashboard/inbox/abc")
  })

  it("renders a plain-text version with the same content", () => {
    const text = submissionNotificationText(props)
    expect(text).toContain("New submission on Contact")
    expect(text).toContain("ali@example.com")
    expect(text).toContain("message: Hello there")
    expect(text).toContain("http://localhost:3000/dashboard/inbox/abc")
  })
})

describe("email-jobs validators", () => {
  it("test email requires a valid address", () => {
    expect(TestEmailSchema.parse({ to: "owner@example.com" })).toEqual({
      to: "owner@example.com",
    })
    expect(TestEmailSchema.safeParse({ to: "not-an-email" }).success).toBe(
      false
    )
  })

  it("list query defaults to page 1 and rejects a bad status", () => {
    expect(EmailJobListQuerySchema.parse({})).toEqual({ page: 1 })
    expect(EmailJobListQuerySchema.safeParse({ status: "BOGUS" }).success).toBe(
      false
    )
    expect(
      EmailJobListQuerySchema.parse({ status: "FAILED", page: "2" })
    ).toEqual({ status: "FAILED", page: 2 })
  })

  it("list query accepts SENDING as a filter (EML-094)", () => {
    expect(EmailJobListQuerySchema.parse({ status: "SENDING" })).toEqual({
      status: "SENDING",
      page: 1,
    })
  })
})

// Cron route auth + concurrent jobs (Phase 16, Wave 1: SRC-115 /
// EML-067). The three jobs are mocked — these tests pin the route's
// own decisions: the bearer check is case-insensitive on the scheme
// and constant-time on the token, and one hit runs all three jobs.
const mockProcessOutbox = vi.hoisted(() =>
  vi.fn(async () => ({ processed: 1, sent: 1, failed: 0 }))
)
const mockRescore = vi.hoisted(() =>
  vi.fn(async () => ({ checked: 2, markedSpam: 0 }))
)
const mockDigests = vi.hoisted(() => vi.fn(async () => ({ sent: 0 })))

vi.mock("@sendcms/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/notifications")>()
  return { ...actual, processEmailOutbox: mockProcessOutbox }
})
vi.mock("@sendcms/submissions", () => ({
  rescoreNewSubmissions: mockRescore,
  sendDueDigests: mockDigests,
}))

import { NextRequest } from "next/server"
import { GET as cronGet } from "../apps/api/app/api/cron/email-outbox/route"

describe("GET /api/cron/email-outbox (SRC-115 / EML-067)", () => {
  const URL = "http://localhost:3001/api/cron/email-outbox"

  function cronRequest(authorization?: string): NextRequest {
    return new NextRequest(URL, {
      headers: authorization ? { Authorization: authorization } : {},
    })
  }

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret")
    mockProcessOutbox.mockClear()
    mockRescore.mockClear()
    mockDigests.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("accepts a lowercase bearer scheme and runs all three jobs", async () => {
    const res = await cronGet(cronRequest("bearer test-cron-secret"))
    expect(res.status).toBe(200)
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    expect(mockRescore).toHaveBeenCalledTimes(1)
    expect(mockDigests).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body).toMatchObject({ processed: 1, rescored: 2, digests: 0 })
  })

  it("accepts the canonical Bearer scheme", async () => {
    const res = await cronGet(cronRequest("Bearer test-cron-secret"))
    expect(res.status).toBe(200)
  })

  it("rejects a wrong token with 401 and runs no jobs", async () => {
    const res = await cronGet(cronRequest("Bearer wrong-secret"))
    expect(res.status).toBe(401)
    expect(mockProcessOutbox).not.toHaveBeenCalled()
    expect(mockRescore).not.toHaveBeenCalled()
    expect(mockDigests).not.toHaveBeenCalled()
  })

  it("rejects a missing Authorization header with 401", async () => {
    const res = await cronGet(cronRequest())
    expect(res.status).toBe(401)
  })

  it("returns 503 when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "")
    const res = await cronGet(cronRequest("Bearer test-cron-secret"))
    expect(res.status).toBe(503)
  })
})
