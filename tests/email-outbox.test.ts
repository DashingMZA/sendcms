import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@react-email/render"
import { resolveEmailProvider, sendPlatformEmail } from "@/lib/email/provider"
import {
  buildSubmissionNotificationSubject,
  nextAttemptDelayMs,
} from "@/lib/services/email-outbox"
import {
  SubmissionNotification,
  submissionNotificationText,
} from "@/lib/email/templates/submission-notification"
import {
  EmailJobListQuerySchema,
  TestEmailSchema,
} from "@/lib/validators/email-jobs"

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

describe("nextAttemptDelayMs", () => {
  it("backs off 1m, 5m, 15m, 1h, then caps at 4h", () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000)
    expect(nextAttemptDelayMs(2)).toBe(5 * 60_000)
    expect(nextAttemptDelayMs(3)).toBe(15 * 60_000)
    expect(nextAttemptDelayMs(4)).toBe(60 * 60_000)
    expect(nextAttemptDelayMs(5)).toBe(4 * 60 * 60_000)
    expect(nextAttemptDelayMs(99)).toBe(4 * 60 * 60_000)
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
    expect(
      EmailJobListQuerySchema.safeParse({ status: "SENDING" }).success
    ).toBe(false)
    expect(
      EmailJobListQuerySchema.parse({ status: "FAILED", page: "2" })
    ).toEqual({ status: "FAILED", page: 2 })
  })
})
