import { afterEach, describe, expect, it, vi } from "vitest"
import nodemailer from "nodemailer"
import {
  buildPlatformTransporter,
  formatFromAddress,
  getPlatformFromAddress,
  redactAuthEmailUrl,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@sendcms/email"

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

describe("buildPlatformTransporter", () => {
  it("returns null when SMTP is not configured", () => {
    expect(buildPlatformTransporter()).toBeNull()
  })

  it("returns null when only some credentials are set", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_USER = "user@example.com"
    expect(buildPlatformTransporter()).toBeNull()
  })

  it("builds a transporter when host, user and pass are set", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_USER = "user@example.com"
    process.env.SMTP_PASS = "secret"
    const transport = buildPlatformTransporter()
    expect(transport).not.toBeNull()
    expect(typeof transport!.sendMail).toBe("function")
  })
})

describe("formatFromAddress", () => {
  it("wraps a bare address with the display name", () => {
    expect(formatFromAddress("SendCMS", "noreply@csofts.com")).toBe(
      '"SendCMS" <noreply@csofts.com>'
    )
  })

  it("uses a full Name <address> mailbox verbatim", () => {
    expect(formatFromAddress("SendCMS", "SendCMS <noreply@csofts.com>")).toBe(
      "SendCMS <noreply@csofts.com>"
    )
  })
})

describe("From header serialization", () => {
  it("renders a clean From header for the user's SMTP_FROM", async () => {
    const transport = nodemailer.createTransport({
      streamTransport: true,
      newline: "unix",
      buffer: true,
    })
    const info = await transport.sendMail({
      from: formatFromAddress("SendCMS", "SendCMS <noreply@csofts.com>"),
      to: "admin@example.com",
      subject: "test",
      text: "hi",
    })
    const raw = info.message.toString()
    expect(raw).toContain("From: SendCMS <noreply@csofts.com>")
    expect(raw).not.toContain("SendCMS>")
  })

  it("documents the old double-wrap bug (regression guard)", async () => {
    const transport = nodemailer.createTransport({
      streamTransport: true,
      newline: "unix",
      buffer: true,
    })
    // The pre-fix construction: display name wrapped around an already
    // complete mailbox. Nodemailer serializes it as From: "SendCMS>".
    const info = await transport.sendMail({
      from: `"SendCMS" <SendCMS <noreply@csofts.com>>`,
      to: "admin@example.com",
      subject: "test",
      text: "hi",
    })
    expect(info.message.toString()).toContain('From: "SendCMS>"')
  })
})

describe("getPlatformFromAddress", () => {
  it("prefers SMTP_FROM, then the SMTP user, then a fallback", () => {
    expect(getPlatformFromAddress()).toBe("noreply@example.com")
    process.env.SMTP_USER = "user@example.com"
    expect(getPlatformFromAddress()).toBe("user@example.com")
    process.env.SMTP_FROM = "SendCMS <hello@sendcms.example>"
    expect(getPlatformFromAddress()).toBe("SendCMS <hello@sendcms.example>")
  })
})

describe("redactAuthEmailUrl", () => {
  it("redacts the token in a reset path, keeping the link shape", () => {
    expect(
      redactAuthEmailUrl(
        "http://localhost:3000/reset-password/tok-abc-123?callbackURL=/dashboard"
      )
    ).toBe(
      "http://localhost:3000/reset-password/<redacted>?callbackURL=/dashboard"
    )
  })

  it("redacts the token query param, keeping the link shape", () => {
    expect(
      redactAuthEmailUrl("http://localhost:3000/verify-email?token=tok-abc-123")
    ).toBe("http://localhost:3000/verify-email?token=<redacted>")
  })

  it("reduces an unknown URL shape to its origin, never logging it whole", () => {
    expect(
      redactAuthEmailUrl("http://localhost:3000/some/other?x=tok-abc-123")
    ).toBe("http://localhost:3000/<redacted>")
    expect(redactAuthEmailUrl("not-a-url")).toBe("<redacted>")
  })
})

describe("auth mailer without SMTP", () => {
  // EML-002 / TST-020: the dev log must carry the link SHAPE, never the
  // bearer-equivalent token. These tests fail if the token appears in
  // any logged line.
  it("logs the verification link shape in non-production and resolves", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendVerificationEmail({
      user: { name: "Zaheer", email: "zaheer@example.com" },
      url: "http://localhost:3000/verify-email?token=tok-abc-123",
    })
    expect(logSpy).toHaveBeenCalledOnce()
    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("[auth-email]")
    expect(line).toContain("zaheer@example.com")
    expect(line).toContain(
      "http://localhost:3000/verify-email?token=<redacted>"
    )
    expect(line).not.toContain("tok-abc-123")
  })

  it("logs the reset link shape in non-production and resolves", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendPasswordResetEmail({
      user: { name: "Zaheer", email: "zaheer@example.com" },
      url: "http://localhost:3000/reset-password/tok-abc-123",
    })
    expect(logSpy).toHaveBeenCalledOnce()
    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("password reset")
    expect(line).toContain("http://localhost:3000/reset-password/<redacted>")
    expect(line).not.toContain("tok-abc-123")
  })

  it("logs the full link only on explicit opt-in", async () => {
    vi.stubEnv("SENDCMS_DEV_LOG_EMAIL_TOKENS", "1")
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await sendVerificationEmail({
        user: { name: "Zaheer", email: "zaheer@example.com" },
        url: "http://localhost:3000/verify-email?token=tok-abc-123",
      })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls[0][0]).toContain(
      "http://localhost:3000/verify-email?token=tok-abc-123"
    )
  })

  it("throws in production when SMTP is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production")
    try {
      await expect(
        sendVerificationEmail({
          user: { name: "Zaheer", email: "zaheer@example.com" },
          url: "http://localhost:3000/verify-email?token=abc",
        })
      ).rejects.toThrow(/no email provider is configured/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
