import { afterEach, describe, expect, it, vi } from "vitest"
import nodemailer from "nodemailer"
import { formatFromAddress } from "@/lib/email/transport"
import {
  buildPlatformTransporter,
  getPlatformFromAddress,
} from "@/lib/email/platform-transport"
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email/auth-mailer"

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

describe("auth mailer without SMTP", () => {
  it("logs the verification link in non-production and resolves", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendVerificationEmail({
      user: { name: "Zaheer", email: "zaheer@example.com" },
      url: "http://localhost:3000/verify-email?token=abc",
    })
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls[0][0]).toContain("zaheer@example.com")
    expect(logSpy.mock.calls[0][0]).toContain(
      "http://localhost:3000/verify-email?token=abc"
    )
  })

  it("logs the reset link in non-production and resolves", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await sendPasswordResetEmail({
      user: { name: "Zaheer", email: "zaheer@example.com" },
      url: "http://localhost:3000/reset-password/abc",
    })
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy.mock.calls[0][0]).toContain("password reset")
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
