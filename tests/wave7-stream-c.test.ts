// Phase 16 Wave 7, Stream C (i18n/RTL): locale-aware formatting,
// localized email templates/subjects, the LocaleProvider default,
// the Radix DirectionProvider passthrough, and the DOC-005 doc-count
// regression test (README + internationalization.md file counts must
// equal the validator's file count).
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { render } from "@react-email/render"
import { renderToString } from "react-dom/server"
import React from "react"
import {
  formatCurrency,
  formatDate,
  formatPlural,
  formatRelativeDate,
  formatTime,
} from "@sendcms/i18n"
import {
  Digest,
  Reply,
  SubmissionNotification,
  VerifyEmail,
  digestText,
  getEmailTranslator,
  submissionNotificationText,
} from "@sendcms/email"
import { buildSubmissionNotificationSubject } from "@sendcms/notifications"
import { DirectionProvider } from "@sendcms/ui"
import {
  LocaleProvider,
  useLocale,
} from "@/apps/dashboard/components/dashboard/translation-provider"

const DATE = new Date("2026-11-24T14:30:00Z")
const NOW = new Date("2026-11-26T14:30:00Z")

describe("formatRelativeDate", () => {
  it("renders English relative times", () => {
    expect(
      formatRelativeDate("en", new Date(NOW.getTime() - 5 * 86400_000), NOW)
    ).toBe("5 days ago")
    expect(
      formatRelativeDate("en", new Date(NOW.getTime() - 86400_000), NOW)
    ).toBe("yesterday")
    expect(
      formatRelativeDate("en", new Date(NOW.getTime() + 3 * 3600_000), NOW)
    ).toBe("in 3 hours")
    expect(formatRelativeDate("en", NOW, NOW)).toBe("now")
  })

  it("renders Urdu relative times", () => {
    expect(
      formatRelativeDate("ur", new Date(NOW.getTime() - 5 * 86400_000), NOW)
    ).toBe("5 دنوں پہلے")
    expect(
      formatRelativeDate("ur", new Date(NOW.getTime() - 86400_000), NOW)
    ).toBe("گزشتہ کل")
    expect(
      formatRelativeDate("ur", new Date(NOW.getTime() + 3 * 3600_000), NOW)
    ).toBe("3 گھنٹے میں")
    expect(formatRelativeDate("ur", NOW, NOW)).toBe("اب")
  })

  it("falls back to English for an unsupported locale", () => {
    expect(
      formatRelativeDate("xx", new Date(NOW.getTime() - 5 * 86400_000), NOW)
    ).toBe("5 days ago")
  })
})

describe("formatDate / formatTime / formatCurrency", () => {
  it("renders the short date in the page locale", () => {
    const opts = { year: "numeric", month: "short", day: "numeric" } as const
    expect(formatDate("en", DATE, opts)).toBe("Nov 24, 2026")
    expect(formatDate("ur", DATE, opts)).toBe("24 نومبر، 2026")
  })

  it("renders the time in the page locale", () => {
    // The timeZone is pinned here on purpose: Intl renders in the
    // process-local timezone, so an unpinned assertion pins UTC only
    // by accident and fails on any machine not set to UTC (PKT renders
    // 7:30 PM, MST 7:30 AM). The helper itself still renders in the
    // host timezone in production (UTC on Vercel).
    expect(formatTime("en", DATE, { timeZone: "UTC" })).toBe("2:30 PM")
    expect(formatTime("ur", DATE, { timeZone: "UTC" })).toBe("2:30 PM")
  })

  it("renders currency in the page locale without throwing", () => {
    expect(formatCurrency("en", 12.5, "USD")).toBe("$12.50")
    expect(formatCurrency("ur", 12.5, "USD")).toBe("$12.50")
    expect(formatCurrency("en", 12.5, "not-a-code")).toBe("12.5 not-a-code")
  })

  it("selects plural forms per locale", () => {
    expect(
      formatPlural("ur", 1, {
        one: "{count} نئی سبمشن",
        other: "{count} نئی سبمشنز",
      })
    ).toBe("1 نئی سبمشن")
    expect(
      formatPlural("ur", 5, {
        one: "{count} نئی سبمشن",
        other: "{count} نئی سبمشنز",
      })
    ).toBe("5 نئی سبمشنز")
  })
})

describe("email templates in Urdu (EML-010)", () => {
  const baseNotification = {
    formName: "Contact",
    senderName: "Ali",
    senderEmail: "ali@example.com",
    fields: [{ label: "message", value: "Hello" }],
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    receivedAt: DATE,
    inboxUrl: "https://dashboard.sendcms.bond/dashboard/inbox/sub-1",
    accentColor: "#0891b2",
    footerText: "footer",
  }

  it("renders the submission notification in Urdu with no English chrome", async () => {
    const html = await render(
      SubmissionNotification({ ...baseNotification, locale: "ur" })
    )
    expect(html).toContain("Contact پر نئی سبمشن")
    expect(html).toContain("ان باکس میں دیکھیں")
    expect(html).not.toContain("New submission on")
    expect(html).not.toContain("View in inbox")
    expect(html).not.toContain("If the button doesn")
    expect(html).not.toContain("Received ")
    expect(html).toContain('lang="ur"')
    expect(html).toContain('dir="rtl"')
  })

  it("renders the submission notification in English by default", async () => {
    const html = await render(SubmissionNotification(baseNotification))
    expect(html).toContain("New submission on Contact")
    expect(html).toContain("View in inbox")
    expect(html).toContain('lang="en"')
  })

  it("localizes the plain-text notification, including the received date", () => {
    const text = submissionNotificationText({
      ...baseNotification,
      locale: "ur",
    })
    expect(text).toContain("Contact پر نئی سبمشن")
    expect(text).toContain("بھیجنے والا: Ali <ali@example.com>")
    // The clock time is matched, not pinned: the template renders in
    // the host timezone (UTC in production), so a fixed "2:30 PM"
    // fails on any machine not set to UTC. The Urdu date format and
    // the presence of a time are what this assertion owns; the exact
    // time value is pinned by the formatTime test above.
    expect(text).toMatch(/موصول: 24 نومبر، 2026 \d{1,2}:\d{2} (AM|PM)/)
    expect(text).not.toContain("From:")
    expect(text).not.toContain("Received:")
  })

  it("renders the verification email in Urdu with no English chrome", async () => {
    const html = await render(
      VerifyEmail({
        userName: "Zaheer",
        url: "https://example.com/verify?token=x",
        accentColor: "#0891b2",
        footerText: "footer",
        locale: "ur",
      })
    )
    expect(html).toContain("ای میل کی تصدیق کریں")
    expect(html).toContain("ہیلو Zaheer،")
    expect(html).not.toContain("Verify email address")
    expect(html).not.toContain("Hi Zaheer,")
  })

  it("renders the digest heading with the Urdu plural", async () => {
    const html = await render(
      Digest({
        formName: "Contact",
        count: 5,
        summary: "Five new messages.",
        highlights: [],
        items: [{ senderName: "Ali", snippet: "Hello", receivedAt: DATE }],
        inboxUrl: "https://dashboard.sendcms.bond/dashboard/inbox",
        accentColor: "#0891b2",
        footerText: "footer",
        locale: "ur",
      })
    )
    expect(html).toContain("Contact پر 5 نئی سبمشنز")
    expect(html).not.toContain("new submissions on")
  })

  it("renders the reply heading in Urdu", async () => {
    const html = await render(
      Reply({
        formName: "Contact",
        body: "Thanks for writing.",
        accentColor: "#0891b2",
        footerText: "footer",
        locale: "ur",
      })
    )
    expect(html).toContain("Re: Contact پر آپ کا پیغام")
    expect(html).not.toContain("Re: your message on")
  })

  it("localizes the digest plain-text fallback", () => {
    const text = digestText({
      formName: "Contact",
      count: 1,
      summary: "One new message.",
      highlights: [],
      items: [{ senderName: "Ali", snippet: "Hello", receivedAt: DATE }],
      inboxUrl: "https://dashboard.sendcms.bond/dashboard/inbox",
      locale: "ur",
    })
    expect(text).toContain("Contact پر 1 نئی سبمشن")
    expect(text).not.toContain("new submission on")
  })
})

describe("email subjects and translator (EML-010)", () => {
  it("builds the notification subject in the recipient locale", () => {
    expect(buildSubmissionNotificationSubject("Contact", "Ali")).toBe(
      "New submission from Ali on Contact"
    )
    expect(buildSubmissionNotificationSubject("Contact", "Ali", "ur")).toBe(
      "Ali کی طرف سے Contact پر نئی سبمشن"
    )
    expect(buildSubmissionNotificationSubject("Contact", null, "ur")).toBe(
      "Contact پر نئی سبمشن"
    )
  })

  it("falls back to English for a locale without an email dictionary", () => {
    const t = getEmailTranslator("es")
    expect(t("authVerifySubject")).toBe("Verify your SendCMS email address")
    expect(getEmailTranslator("ur")("authVerifySubject")).toBe(
      "اپنا SendCMS ای میل پتہ تصدیق کریں"
    )
  })
})

describe("LocaleProvider / useLocale", () => {
  function Probe() {
    return React.createElement("span", null, useLocale())
  }

  it("exposes the provided locale", () => {
    const html = renderToString(
      React.createElement(
        LocaleProvider,
        { locale: "ur" },
        React.createElement(Probe)
      )
    )
    expect(html).toContain("ur")
  })

  it("defaults to English outside a provider", () => {
    const html = renderToString(React.createElement(Probe))
    expect(html).toContain("en")
  })
})

describe("DirectionProvider (I18N-303)", () => {
  it("renders children under a Radix Direction provider", () => {
    const html = renderToString(
      React.createElement(
        DirectionProvider,
        { dir: "rtl" },
        React.createElement("span", null, "child")
      )
    )
    expect(html).toContain("child")
  })
})

describe("i18n doc counts (DOC-005)", () => {
  function countLocaleFiles(): number {
    const dir = path.join(process.cwd(), "packages/i18n/locales/en")
    let count = 0
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(d, entry.name))
        else if (entry.name.endsWith(".json")) count++
      }
    }
    walk(dir)
    return count
  }

  it("README and internationalization.md file counts match the validator's file count", () => {
    const files = countLocaleFiles()
    expect(files).toBeGreaterThan(0)
    const readme = readFileSync(
      path.join(process.cwd(), "packages/i18n/README.md"),
      "utf8"
    )
    const doc = readFileSync(
      path.join(
        process.cwd(),
        "docs/admin-control-plane/internationalization.md"
      ),
      "utf8"
    )
    expect(readme).toContain(`${files} (19 shared + 27 admin + 14 dashboard)`)
    expect(readme).toContain(`Source locale: en — ${files} files`)
    expect(doc).toContain(`${files} (19 shared + 27 admin + 14 dashboard)`)
    expect(doc).toContain(`Source locale: en — ${files} files`)
  })
})
