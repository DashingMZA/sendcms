import { afterEach, describe, expect, it, vi } from "vitest"
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
      ).rejects.toThrow(/SMTP is not configured/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
