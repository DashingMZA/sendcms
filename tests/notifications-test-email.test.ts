// Test-submission email (AIM-010): the provider's failure message
// names the platform's email configuration, so it must never reach
// the caller — only a generic 502, with the detail kept server-side
// in the log. The real template renders; only the send is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFormFindFirst = vi.hoisted(() => vi.fn())
const mockSendEmail = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: { form: { findFirst: mockFormFindFirst } } }
})
vi.mock("@sendcms/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/email")>()
  return {
    ...actual,
    notificationDeps: {
      ...actual.notificationDeps,
      sendEmail: mockSendEmail,
    },
  }
})
vi.mock("@sendcms/observability", () => ({
  createLogger: () => mockLogger,
}))

import { sendTestSubmissionEmail } from "@sendcms/notifications"

beforeEach(() => {
  vi.clearAllMocks()
  mockFormFindFirst.mockResolvedValue({ id: "form-1", name: "Contact us" })
})

describe("sendTestSubmissionEmail", () => {
  it("returns a generic 502 with no provider config detail when no provider is configured", async () => {
    mockSendEmail.mockRejectedValue(
      new Error(
        "No email provider configured (set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS)."
      )
    )
    let thrown: unknown
    try {
      await sendTestSubmissionEmail("user-1", "form-1", "owner@example.com")
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({
      status: 502,
      message: "Could not send the test email.",
    })
    // The regression assertion: no config variable name leaks.
    expect(String((thrown as Error).message)).not.toContain("RESEND_API_KEY")
    expect(String((thrown as Error).message)).not.toContain("SMTP_")
    // ...but the detail is kept server-side in the log.
    expect(mockLogger.error).toHaveBeenCalledWith(
      "test submission email failed",
      expect.objectContaining({ formId: "form-1" })
    )
    const loggedError = mockLogger.error.mock.calls[0][1].error as Error
    expect(loggedError.message).toContain("RESEND_API_KEY")
  })

  it("sends through the provider when configured", async () => {
    mockSendEmail.mockResolvedValue({
      messageId: "msg-1",
      provider: "resend",
    })
    const result = await sendTestSubmissionEmail(
      "user-1",
      "form-1",
      "owner@example.com"
    )
    expect(result).toEqual({ messageId: "msg-1", provider: "resend" })
  })

  it("404s for a form the user does not own", async () => {
    mockFormFindFirst.mockResolvedValue(null)
    await expect(
      sendTestSubmissionEmail("user-1", "form-1", "owner@example.com")
    ).rejects.toMatchObject({ status: 404 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})
