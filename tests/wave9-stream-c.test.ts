// Wave 9, Stream C (email delivery / suppression / unsubscribe /
// auth-mail durability) — regression tests for EML-005, EML-008,
// EML-009, EML-011, EML-012, SRC-217, SRC-312, SRC-313 and DSH-406.
// Mocked Prisma client; no test hits the real DB. Live Resend/SMTP
// delivery is NOT performed — providers are stubbed or faked locally.
import { createHmac } from "node:crypto"
import net from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@react-email/render"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  submission: { findUnique: vi.fn(), findFirst: vi.fn() },
  submissionEvent: { create: vi.fn() },
  notificationSettings: { findMany: vi.fn(), updateMany: vi.fn() },
  emailSuppression: { findFirst: vi.fn(), create: vi.fn() },
  emailJob: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  },
  form: { findUnique: vi.fn() },
  supportTicket: { count: vi.fn() },
  user: { findUnique: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})
vi.mock("@sendcms/users", () => ({
  getUserLocale: vi.fn(async () => null),
}))

import { SubmissionEventType } from "@sendcms/database"
import {
  buildPlatformTransporter,
  buildUnsubscribeUrl,
  notificationDeps,
  sendPasswordResetEmail,
  sendPlatformEmail,
  sendVerificationEmail,
  SubmissionNotification,
  truncateFieldValue,
  validateResendSender,
  verifyUnsubscribeToken,
} from "@sendcms/email"
import { countNewTickets } from "@sendcms/support"
import {
  enqueueSubmissionNotifications,
  handleResendDeliveryEvent,
  handleResendWebhookRequest,
  listEmailJobsForUser,
  processEmailOutbox,
  unsubscribeRecipient,
} from "@sendcms/notifications"
import { sendReplyToSubmission } from "@sendcms/inbox"
import type { AdminSession } from "@sendcms/auth"

const ENV_KEYS = [
  "RESEND_API_KEY",
  "RESEND_FROM",
  "RESEND_VERIFIED_DOMAINS",
  "RESEND_WEBHOOK_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "BETTER_AUTH_SECRET",
  "NEXT_PUBLIC_API_URL",
  "BETTER_AUTH_URL",
] as const

const savedNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.submission.findUnique.mockResolvedValue(null)
  mockDb.submission.findFirst.mockResolvedValue(null)
  mockDb.submissionEvent.create.mockResolvedValue({})
  mockDb.notificationSettings.findMany.mockResolvedValue([])
  mockDb.notificationSettings.updateMany.mockResolvedValue({ count: 0 })
  mockDb.emailSuppression.findFirst.mockResolvedValue(null)
  mockDb.emailSuppression.create.mockResolvedValue({})
  mockDb.emailJob.createMany.mockResolvedValue({ count: 0 })
  mockDb.emailJob.findMany.mockResolvedValue([])
  mockDb.emailJob.findFirst.mockResolvedValue(null)
  mockDb.emailJob.findUnique.mockResolvedValue(null)
  mockDb.emailJob.updateMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.update.mockResolvedValue({})
  mockDb.emailJob.groupBy.mockResolvedValue([])
  mockDb.emailJob.count.mockResolvedValue(0)
  mockDb.form.findUnique.mockResolvedValue(null)
  mockDb.supportTicket.count.mockResolvedValue(0)
  mockDb.user.findUnique.mockResolvedValue(null)
})

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.NODE_ENV = savedNodeEnv
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    status: "NEW",
    data: { name: "Sara", email: "sara@example.com", message: "Hello" },
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    createdAt: new Date("2026-11-17T10:00:00Z"),
    form: { id: "form-1", name: "Contact us", ownerId: "user-1" },
    ...overrides,
  }
}

function makeAdminActor(): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: "SUPER_ADMIN",
      emailVerified: true,
    },
    session: {
      id: "sess-1",
      userId: "admin-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

// ─── EML-005: signed Resend webhook ─────────────────────────────────

describe("EML-005 Resend delivery webhook", () => {
  const WEBHOOK_SECRET =
    "whsec_" + Buffer.from("test-webhook-secret").toString("base64")

  function signPayload(payload: string) {
    const svixId = "msg_test123"
    const svixTimestamp = String(Math.floor(Date.now() / 1000))
    const rawSecret = Buffer.from("test-webhook-secret")
    const signature = createHmac("sha256", rawSecret)
      .update(`${svixId}.${svixTimestamp}.${payload}`, "utf8")
      .digest("base64")
    return {
      svixId,
      svixTimestamp,
      svixSignature: `v1,${signature}`,
    }
  }

  function bouncedPayload() {
    return JSON.stringify({
      type: "email.bounced",
      created_at: "2026-11-25T00:00:00Z",
      data: {
        email_id: "msg-1",
        from: "noreply@sendcms.test",
        to: ["dead@example.com"],
        subject: "New submission",
        bounce: { type: "hard_bounce", message: "550 user unknown" },
      },
    })
  }

  it("signed bounced webhook: job reflects the bounce and the recipient is suppressed", async () => {
    mockDb.emailJob.findFirst.mockResolvedValue({
      id: "job-1",
      formId: "form-1",
    })
    const payload = bouncedPayload()
    const signed = signPayload(payload)
    const result = await handleResendWebhookRequest({
      payload,
      ...signed,
      secret: WEBHOOK_SECRET,
    })
    expect(result).toEqual({ ok: true, matched: true, suppressed: true })
    expect(mockDb.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: expect.objectContaining({ deliveryStatus: "BOUNCED" }),
      })
    )
    expect(mockDb.emailSuppression.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "dead@example.com",
          reason: "BOUNCED",
        }),
      })
    )
  })

  it("a suppressed recipient gets no further job", async () => {
    mockDb.submission.findUnique.mockResolvedValue(makeSubmission())
    mockDb.notificationSettings.findMany.mockResolvedValue([
      { email: "dead@example.com" },
    ])
    mockDb.emailSuppression.findFirst.mockResolvedValue({
      id: "sup-1",
    })
    const n = await enqueueSubmissionNotifications("form-1", "sub-1")
    expect(n).toBe(0)
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })

  it("rejects a tampered signature with 401 and writes nothing", async () => {
    const payload = bouncedPayload()
    const signed = signPayload(payload)
    const result = await handleResendWebhookRequest({
      payload: payload.replace("dead@example.com", "other@example.com"),
      ...signed,
      secret: WEBHOOK_SECRET,
    })
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Invalid webhook signature.",
    })
    expect(mockDb.emailJob.update).not.toHaveBeenCalled()
    expect(mockDb.emailSuppression.create).not.toHaveBeenCalled()
  })

  it("returns 503 when the webhook secret is not configured", async () => {
    const payload = bouncedPayload()
    const signed = signPayload(payload)
    const result = await handleResendWebhookRequest({
      payload,
      ...signed,
      secret: undefined,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(503)
  })

  it("delivered updates the job without suppressing; transient bounce is ignored", async () => {
    mockDb.emailJob.findFirst.mockResolvedValue({
      id: "job-1",
      formId: "form-1",
    })
    const delivered = await handleResendDeliveryEvent({
      type: "email.delivered",
      created_at: "2026-11-25T00:00:00Z",
      data: {
        email_id: "msg-1",
        from: "noreply@sendcms.test",
        to: ["owner@example.com"],
        subject: "New submission",
      },
    })
    expect(delivered).toEqual({ matched: true, suppressed: false })
    expect(mockDb.emailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryStatus: "DELIVERED" }),
      })
    )
    expect(mockDb.emailSuppression.create).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const transient = await handleResendDeliveryEvent({
      type: "email.bounced",
      created_at: "2026-11-25T00:00:00Z",
      data: {
        email_id: "msg-2",
        from: "noreply@sendcms.test",
        to: ["owner@example.com"],
        subject: "New submission",
        bounce: { type: "transient" },
      },
    })
    expect(transient).toEqual({ matched: false, suppressed: false })
    expect(mockDb.emailJob.update).not.toHaveBeenCalled()
  })

  it("the delivery log surfaces the persisted delivery status", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([
      {
        id: "job-1",
        status: "SENT",
        deliveryStatus: "BOUNCED",
        deliveryUpdatedAt: new Date(),
        claimedAt: null,
        updatedAt: new Date(),
        form: { name: "Contact us" },
      },
    ])
    mockDb.emailJob.count.mockResolvedValue(1)
    mockDb.emailJob.groupBy.mockResolvedValue([{ status: "SENT", _count: 1 }])
    const page = await listEmailJobsForUser("user-1", {})
    expect(page.items[0].deliveryStatus).toBe("BOUNCED")
  })
})

// ─── EML-008: RESEND_FROM validation ────────────────────────────────

describe("EML-008 RESEND_FROM validation", () => {
  it("fails fast naming RESEND_FROM when the key is set but the sender is not", async () => {
    process.env.RESEND_API_KEY = "re_test"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      sendPlatformEmail({ to: "a@b.co", subject: "hi", html: "<p>hi</p>" })
    ).rejects.toThrow("RESEND_FROM")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("validateResendSender: unset, placeholder, bad shape and wrong domain", () => {
    expect(validateResendSender({})).toEqual({
      ok: false,
      error: expect.stringContaining("RESEND_FROM is not set"),
    })
    expect(
      validateResendSender({ RESEND_FROM: "noreply@example.com" })
    ).toEqual({
      ok: false,
      error: expect.stringContaining("example.com"),
    })
    expect(validateResendSender({ RESEND_FROM: "not-an-address" })).toEqual({
      ok: false,
      error: expect.stringContaining("RESEND_FROM is not a valid"),
    })
    expect(
      validateResendSender({
        RESEND_FROM: "noreply@other.test",
        RESEND_VERIFIED_DOMAINS: "sendcms.test",
      })
    ).toEqual({
      ok: false,
      error: expect.stringContaining("RESEND_VERIFIED_DOMAINS"),
    })
  })

  it("validateResendSender: accepts a verified-domain sender", () => {
    expect(
      validateResendSender({
        RESEND_FROM: "SendCMS <noreply@sendcms.test>",
        RESEND_VERIFIED_DOMAINS: "sendcms.test",
      })
    ).toEqual({
      ok: true,
      from: "SendCMS <noreply@sendcms.test>",
      domain: "sendcms.test",
    })
  })
})

// ─── EML-009 + SRC-312: auth mail durability ─────────────────────────

describe("EML-009 / SRC-312 auth mail through the outbox", () => {
  it("provider failure (Resend 500, NODE_ENV=test): rejects with the real cause and leaves a durable failed record", async () => {
    process.env.NODE_ENV = "test"
    process.env.RESEND_API_KEY = "re_test"
    process.env.RESEND_FROM = "noreply@sendcms.test"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "Resend is down" }),
      })
    )
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const onSendFailure = vi.fn(async () => {})
    await expect(
      sendPasswordResetEmail({
        user: { name: "Sara", email: "sara@example.com" },
        url: "https://dashboard.sendcms.test/reset-password/tok-1",
        onSendFailure,
      })
    ).rejects.toThrow("Resend is down")
    // EML-009: the failure is visible (recipient + kind at error
    // level) and leaves a durable, retryable record for the outbox.
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0][0]).toContain("sara@example.com")
    expect(consoleError.mock.calls[0][0]).toContain("password reset")
    expect(onSendFailure).toHaveBeenCalledTimes(1)
    expect(onSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "password reset",
        to: "sara@example.com",
        html: expect.stringContaining("reset-password"),
      })
    )
  })

  it("no provider + development: logs the [auth-email] link and resolves", async () => {
    process.env.NODE_ENV = "development"
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendVerificationEmail({
      user: { name: "Sara", email: "sara@example.com" },
      url: "https://dashboard.sendcms.test/verify-email?token=tok-1",
    })
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("[auth-email]")
    )
    expect(consoleLog.mock.calls[0][0]).toContain("sara@example.com")
  })

  it("no provider + production: throws instead of logging a live link", async () => {
    process.env.NODE_ENV = "production"
    await expect(
      sendVerificationEmail({
        user: { name: "Sara", email: "sara@example.com" },
        url: "https://dashboard.sendcms.test/verify-email?token=tok-1",
      })
    ).rejects.toThrow("no email provider is configured")
  })
})

// ─── SRC-313: STARTTLS required ──────────────────────────────────────

describe("SRC-313 SMTP requires STARTTLS", () => {
  it("a mock SMTP server without STARTTLS on 587 fails the send and never sees credentials", async () => {
    const received: string[] = []
    const server = net.createServer((socket) => {
      socket.write("220 localhost ESMTP\r\n")
      socket.on("data", (chunk) => {
        const text = chunk.toString()
        received.push(text)
        if (/^EHLO/i.test(text)) {
          // No STARTTLS advertised — a plaintext fallback would
          // carry the credentials in the clear.
          socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n")
        } else if (/^QUIT/i.test(text)) {
          socket.write("221 Bye\r\n")
          socket.end()
        } else {
          socket.write("250 OK\r\n")
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) {
      throw new Error("fake SMTP server did not bind")
    }
    process.env.SMTP_HOST = "127.0.0.1"
    process.env.SMTP_PORT = String(address.port)
    process.env.SMTP_USER = "user@example.com"
    process.env.SMTP_PASS = "secret"
    const mail = {
      from: "SendCMS <noreply@sendcms.test>",
      to: "a@b.co",
      subject: "hi",
      text: "hi",
    }
    try {
      // Control: without requireTLS the same server accepts the
      // mail — and the credentials travel in plaintext (AUTH is
      // visible in the transcript). This is the hole SRC-313 closes.
      const insecure = (await import("nodemailer")).default.createTransport({
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        auth: { user: "user@example.com", pass: "secret" },
      })
      await insecure.sendMail(mail)
      expect(received.join("")).toMatch(/AUTH/i)
      insecure.close()

      // Fixed path: buildPlatformTransporter() sets requireTLS, so
      // the send fails at the STARTTLS upgrade instead of falling
      // back to plaintext — and AUTH never appears.
      received.length = 0
      const transport = buildPlatformTransporter()
      expect(transport).not.toBeNull()
      try {
        await expect(transport!.sendMail(mail)).rejects.toThrow()
      } finally {
        transport!.close()
      }
      expect(received.join("")).not.toMatch(/AUTH/i)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ─── EML-011: unsubscribe ────────────────────────────────────────────

describe("EML-011 unsubscribe", () => {
  const SECRET = "test-unsubscribe-secret"

  it("a rendered notification carries a working signed unsubscribe URL", async () => {
    const url = buildUnsubscribeUrl("owner@example.com", "form-1", {
      secret: SECRET,
      baseUrl: "http://localhost:3001",
    })
    expect(url).toContain("/api/public/v1/unsubscribe?token=")
    const token = new URL(url!).searchParams.get("token")!
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({
      email: "owner@example.com",
      formId: "form-1",
    })
    const html = await render(
      SubmissionNotification({
        formName: "Contact",
        senderName: "Ali",
        senderEmail: "ali@example.com",
        fields: [{ label: "message", value: "Hello" }],
        pageUrl: "https://example.com/contact",
        originDomain: "example.com",
        receivedAt: new Date("2026-11-17T10:00:00Z"),
        inboxUrl: "http://localhost:3000/dashboard/inbox/abc",
        accentColor: "#0891b2",
        footerText: "Test footer.",
        unsubscribeUrl: url,
      })
    )
    expect(html).toContain(url!)
  })

  it("a tampered token verifies to null", () => {
    const url = buildUnsubscribeUrl("owner@example.com", "form-1", {
      secret: SECRET,
      baseUrl: "http://localhost:3001",
    })!
    const token = new URL(url).searchParams.get("token")!
    const tampered = token.slice(0, -2) + "AA"
    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeNull()
  })

  it("clicking it stops further jobs for that recipient", async () => {
    mockDb.notificationSettings.updateMany.mockResolvedValue({ count: 1 })
    const result = await unsubscribeRecipient({
      email: "owner@example.com",
      formId: "form-1",
    })
    expect(result).toEqual({ disabledSettings: 1 })
    expect(mockDb.emailSuppression.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "owner@example.com",
          reason: "UNSUBSCRIBED",
        }),
      })
    )
    expect(mockDb.notificationSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: "owner@example.com",
          formId: "form-1",
        }),
        data: { enabled: false },
      })
    )
    // The next enqueue for the same recipient finds the suppression
    // and creates no job.
    mockDb.submission.findUnique.mockResolvedValue(makeSubmission())
    mockDb.notificationSettings.findMany.mockResolvedValue([
      { email: "owner@example.com" },
    ])
    mockDb.emailSuppression.findFirst.mockResolvedValue({ id: "sup-1" })
    expect(await enqueueSubmissionNotifications("form-1", "sub-1")).toBe(0)
    expect(mockDb.emailJob.createMany).not.toHaveBeenCalled()
  })

  it("the send path carries a List-Unsubscribe header", async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret"
    const sendSpy = vi
      .spyOn(notificationDeps, "sendEmail")
      .mockResolvedValue({ messageId: "msg-1", provider: "resend" })
    const job = {
      id: "job-1",
      type: "SUBMISSION_NOTIFICATION",
      to: "owner@example.com",
      subject: "New submission",
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: null,
      formId: "form-1",
      submissionId: "sub-1",
      ownerId: "user-1",
      createdAt: new Date(),
    }
    mockDb.emailJob.findMany.mockResolvedValue([job])
    mockDb.emailJob.findUnique.mockImplementation(async (args: unknown) => {
      const a = args as { select?: { attempts?: boolean }; include?: unknown }
      if (a.select?.attempts) return { attempts: 1 }
      if (a.include)
        return {
          ...job,
          form: { id: "form-1", name: "Contact us" },
          submission: makeSubmission(),
        }
      return null
    })
    const out = await processEmailOutbox({ limit: 1 })
    expect(out).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 0 })
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "List-Unsubscribe": expect.stringContaining(
            "/api/public/v1/unsubscribe?token="
          ),
        }),
      })
    )
  })
})

// ─── EML-012: render-time truncation ─────────────────────────────────

describe("EML-012 render-time truncation", () => {
  it("truncateFieldValue caps at 2,000 chars with an ellipsis", () => {
    expect(truncateFieldValue("x".repeat(2000))).toBe("x".repeat(2000))
    expect(truncateFieldValue("x".repeat(2001))).toBe("x".repeat(2000) + "…")
  })

  it("a 10,000-char field renders truncated HTML under the cap, with an inbox link", async () => {
    const longValue = "x".repeat(10000)
    const html = await render(
      SubmissionNotification({
        formName: "Contact",
        senderName: "Ali",
        senderEmail: "ali@example.com",
        fields: [{ label: "message", value: longValue }],
        pageUrl: "https://example.com/contact",
        originDomain: "example.com",
        receivedAt: new Date("2026-11-17T10:00:00Z"),
        inboxUrl: "http://localhost:3000/dashboard/inbox/abc",
        accentColor: "#0891b2",
        footerText: "Test footer.",
      })
    )
    expect(html).not.toContain("x".repeat(5000))
    expect(html).toContain("x".repeat(2000) + "…")
    expect(html).toContain("http://localhost:3000/dashboard/inbox/abc")
    expect(html.length).toBeLessThan(20000)
  })
})

// ─── SRC-217: reply timeline events ──────────────────────────────────

describe("SRC-217 reply records EMAIL_SENT only on delivery", () => {
  function makeReplyJob(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-reply-1",
      type: "SUBMISSION_REPLY",
      to: "sara@example.com",
      subject: "Re: Contact",
      status: "PENDING",
      attempts: 5,
      nextAttemptAt: null,
      lastError: null,
      providerMessageId: null,
      formId: "form-1",
      submissionId: "sub-1",
      ownerId: "user-1",
      createdAt: new Date(),
      payload: {
        formName: "Contact us",
        body: "Thanks for writing.",
        accentColor: "#0891b2",
        footerText: "Reply footer.",
        locale: "en",
      },
      ...overrides,
    }
  }

  it("enqueue writes EMAIL_QUEUED, never EMAIL_SENT", async () => {
    mockDb.submission.findFirst.mockResolvedValue(makeSubmission())
    mockDb.form.findUnique.mockResolvedValue({ ownerId: "user-1" })
    mockDb.emailJob.createMany.mockResolvedValue({ count: 1 })
    const result = await sendReplyToSubmission("user-1", "sub-1", {
      subject: "Re: Contact",
      body: "Thanks for writing.",
    })
    expect(result).toEqual({ enqueued: 1 })
    expect(mockDb.submissionEvent.create).toHaveBeenCalledTimes(1)
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: SubmissionEventType.EMAIL_QUEUED,
          detail: { reply: true, queued: true },
        }),
      })
    )
    expect(mockDb.submissionEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: SubmissionEventType.EMAIL_SENT,
        }),
      })
    )
  })

  it("a permanently failed reply job gets EMAIL_FAILED, never EMAIL_SENT", async () => {
    vi.spyOn(notificationDeps, "sendEmail").mockRejectedValue(
      new Error("Resend down")
    )
    mockDb.emailJob.findMany.mockResolvedValue([makeReplyJob()])
    mockDb.emailJob.findUnique.mockResolvedValue({ attempts: 6 })
    const out = await processEmailOutbox({ limit: 1 })
    expect(out).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 })
    const types = mockDb.submissionEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { type: string } }).data.type
    )
    expect(types).toContain(SubmissionEventType.EMAIL_FAILED)
    expect(types).not.toContain(SubmissionEventType.EMAIL_SENT)
  })

  it("a delivered reply job gets EMAIL_SENT on confirmation", async () => {
    vi.spyOn(notificationDeps, "sendEmail").mockResolvedValue({
      messageId: "msg-1",
      provider: "resend",
    })
    mockDb.emailJob.findMany.mockResolvedValue([makeReplyJob({ attempts: 0 })])
    mockDb.emailJob.findUnique.mockResolvedValue({ attempts: 1 })
    const out = await processEmailOutbox({ limit: 1 })
    expect(out).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 0 })
    expect(mockDb.submissionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: SubmissionEventType.EMAIL_SENT,
        }),
      })
    )
  })
})

// ─── DSH-406: admin-shell new-ticket counts ──────────────────────────
// Owner decision 2026-11-25, option (b): admin-shell new-ticket counts,
// NOT email/notification.

describe("DSH-406 admin-shell new-ticket counts", () => {
  it("create a ticket → count increments; resolve/close → count decrements", async () => {
    mockDb.supportTicket.count.mockResolvedValue(0)
    expect(await countNewTickets(makeAdminActor())).toBe(0)
    mockDb.supportTicket.count.mockResolvedValue(1)
    expect(await countNewTickets(makeAdminActor())).toBe(1)
    mockDb.supportTicket.count.mockResolvedValue(0)
    expect(await countNewTickets(makeAdminActor())).toBe(0)
    expect(mockDb.supportTicket.count).toHaveBeenCalledWith({
      where: { status: "OPEN" },
    })
  })
})
