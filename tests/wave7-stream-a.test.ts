// Wave 7 Stream A (i18n / RTL): missing-key coverage (I18N-001–008,
// I18N-201/202, ADM-096/121/122/003/031), hardcoded-string triage
// (I18N-009), unused-key drift (I18N-012), validate automation
// (TST-008), and the SRC-326 loader/formatter guards.
//
// Conventions: vitest runs with the repo root as cwd; the validate
// script is exercised through a child process (its exit code is the
// gate), with temp fixture roots for the negative cases.
import { execFile } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  formatCurrency,
  formatDate,
  formatPlural,
  formatTime,
  isValidTranslationMessages,
  loadLocaleAppDomain,
  loadLocaleDomain,
} from "@sendcms/i18n"

function runScript(
  script: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        })
      }
    )
  })
}

describe("SRC-326: dynamic-import guards (load.ts)", () => {
  it("rejects path traversal in locale / app / domain", async () => {
    await expect(loadLocaleDomain("..", "..")).rejects.toThrow(RangeError)
    await expect(loadLocaleDomain("en", "../common")).rejects.toThrow(
      RangeError
    )
    await expect(loadLocaleDomain("en", "common/x")).rejects.toThrow(RangeError)
    await expect(loadLocaleAppDomain("en", "..", "x")).rejects.toThrow(
      RangeError
    )
    await expect(loadLocaleAppDomain("en", "admin", "..")).rejects.toThrow(
      RangeError
    )
  })

  it("rejects unsupported locale codes", async () => {
    await expect(loadLocaleDomain("xx", "common")).rejects.toThrow(RangeError)
    await expect(loadLocaleDomain("", "common")).rejects.toThrow(RangeError)
  })

  it("loads a real domain for a supported locale", async () => {
    const messages = await loadLocaleDomain("en", "common")
    expect(typeof messages).toBe("object")
    expect(Object.keys(messages).length).toBeGreaterThan(0)
    expect(Object.values(messages).every((v) => typeof v === "string")).toBe(
      true
    )
  })

  it("validates message shapes (isValidTranslationMessages)", () => {
    expect(isValidTranslationMessages({ a: "x" })).toBe(true)
    expect(isValidTranslationMessages({})).toBe(true)
    expect(isValidTranslationMessages([])).toBe(false)
    expect(isValidTranslationMessages(["a"])).toBe(false)
    expect(isValidTranslationMessages(1)).toBe(false)
    expect(isValidTranslationMessages(null)).toBe(false)
    expect(isValidTranslationMessages({ a: 1 })).toBe(false)
    expect(isValidTranslationMessages({ a: null })).toBe(false)
  })
})

describe("SRC-326: formatters never throw on bad input", () => {
  it("formatPlural falls back to English on an invalid locale tag", () => {
    const forms = { one: "{count} item", other: "{count} items" }
    expect(formatPlural("not a locale!!", 1, forms)).toBe("1 item")
    expect(formatPlural("not a locale!!", 3, forms)).toBe("3 items")
    expect(formatPlural("en", 1, forms)).toBe("1 item")
  })

  it("formatCurrency falls back to number + code on an invalid code", () => {
    expect(formatCurrency("en", 10, "BOGUS")).toBe("10 BOGUS")
    expect(formatCurrency("en", 10, "12")).toBe("10 12")
    expect(formatCurrency("en", 10, "usd")).toBe("$10.00")
  })

  it("formatDate / formatTime return empty for an unparseable date", () => {
    expect(formatDate("en", "not-a-date")).toBe("")
    expect(formatDate("en", new Date(Number.NaN))).toBe("")
    expect(formatTime("en", "not-a-date")).toBe("")
    expect(formatDate("en", "2026-11-24")).toContain("2026")
  })
})

describe("SRC-326: code-usage check resolves intermediate map lookups", () => {
  it("counts the email-jobs status keys as used (I18N-012)", async () => {
    // email-jobs-table.tsx does `const labelKey =
    // STATUS_LABEL_KEYS[job.status]` then `t(labelKey)` — the
    // intermediate-variable shape the Phase 6 scanner missed (it
    // listed these 4 as unused). The Node checker must resolve the
    // map, or I18N-012 would delete live keys.
    const dir = mkdtempSync(join(tmpdir(), "sendcms-i18n-dump-"))
    const dump = join(dir, "used.json")
    try {
      const { code, stdout } = await runScript(
        "packages/i18n/scripts/check-code-usage.mjs",
        { SENDCMS_I18N_DUMP_USED: dump }
      )
      expect(code).toBe(0)
      expect(stdout).toContain("every key used in code exists")
      const pairs = JSON.parse(readFileSync(dump, "utf8")) as {
        app: string
        domain: string
        key: string
      }[]
      for (const key of [
        "statusPending",
        "statusSending",
        "statusSent",
        "statusFailed",
      ]) {
        expect(
          pairs.some(
            (p) =>
              p.app === "apps/dashboard" &&
              p.domain === "notifications" &&
              p.key === key
          )
        ).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Full-repo code-usage scan; ~4.3s under load — above the 5s
    // default is plausible, so allow 30s.
  }, 30_000)
})

describe("TST-008: validate runs and gates (I18N-001–008, SRC-326)", () => {
  it("passes on the real repo (parity + code usage + placeholders)", async () => {
    const { code, stdout } = await runScript(
      "packages/i18n/scripts/validate-translations.mjs"
    )
    expect(code).toBe(0)
    expect(stdout).toContain("every key used in code exists")
    expect(stdout).toContain("en and ur are complete and in sync")
    // Full-repo validate scans ~200 files; under parallel test load
    // it can exceed vitest's 5s default (timed out 2026-11-24).
  }, 30_000)

  it("fails on a fixture where ur drops a {placeholder} (SRC-326)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sendcms-i18n-fixture-"))
    try {
      mkdirSync(join(root, "en", "admin"), { recursive: true })
      mkdirSync(join(root, "ur", "admin"), { recursive: true })
      writeFileSync(
        join(root, "en", "admin", "test.json"),
        JSON.stringify({ greeting: "Hello {name}", plain: "Plain" })
      )
      writeFileSync(
        join(root, "ur", "admin", "test.json"),
        JSON.stringify({ greeting: "ہیلو", plain: "سادہ" })
      )
      const { code, stdout } = await runScript(
        "packages/i18n/scripts/validate-translations.mjs",
        { SENDCMS_I18N_LOCALES_DIR: root }
      )
      expect(code).toBe(1)
      expect(stdout).toContain('key "greeting" placeholder mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("code-usage check fails on a fixture with a missing key (I18N-001)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sendcms-i18n-usage-"))
    try {
      mkdirSync(join(root, "packages", "i18n", "src"), { recursive: true })
      mkdirSync(join(root, "packages", "i18n", "locales", "en", "admin"), {
        recursive: true,
      })
      mkdirSync(join(root, "apps", "admin", "components"), {
        recursive: true,
      })
      writeFileSync(
        join(root, "packages", "i18n", "src", "load.ts"),
        'export const SHARED_DOMAINS = ["common"] as const\n' +
          'export const ADMIN_DOMAINS = ["test"] as const\n' +
          "export const DASHBOARD_DOMAINS = [] as const\n"
      )
      writeFileSync(
        join(root, "packages", "i18n", "locales", "en", "admin", "test.json"),
        JSON.stringify({ present: "Present" })
      )
      writeFileSync(
        join(root, "apps", "admin", "components", "c.tsx"),
        'import { useTranslation } from "@/components/admin/translation-provider"\n' +
          "export function C() {\n" +
          '  const { t } = useTranslation("test")\n' +
          '  return <p>{t("present")} {t("missingKey")}</p>\n' +
          "}\n"
      )
      const missing = await runScript(
        "packages/i18n/scripts/check-code-usage.mjs",
        { SENDCMS_I18N_REPO_ROOT: root }
      )
      expect(missing.code).toBe(1)
      expect(missing.stdout).toContain('"missingKey"')
      // Adding the key closes it.
      writeFileSync(
        join(root, "packages", "i18n", "locales", "en", "admin", "test.json"),
        JSON.stringify({ present: "Present", missingKey: "Missing" })
      )
      const fixed = await runScript(
        "packages/i18n/scripts/check-code-usage.mjs",
        { SENDCMS_I18N_REPO_ROOT: root }
      )
      expect(fixed.code).toBe(0)
      expect(fixed.stdout).toContain("every key used in code exists")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("I18N-009: hardcoded UI strings converted to t()", () => {
  it("admin error boundary renders through the navigation domain", () => {
    const source = readFileSync("apps/admin/app/error.tsx", "utf8")
    for (const literal of [
      "Something went wrong",
      "This admin page could not be loaded",
      "Try again",
      "Back to the dashboard",
    ]) {
      expect(source).not.toContain(literal)
    }
    for (const key of [
      "errorTitle",
      "errorDescription",
      "errorTryAgain",
      "errorGoToDashboard",
    ]) {
      expect(source).toContain(`t("${key}")`)
      for (const locale of ["en", "ur"] as const) {
        const messages = JSON.parse(
          readFileSync(
            `packages/i18n/locales/${locale}/admin/navigation.json`,
            "utf8"
          )
        ) as Record<string, string>
        expect(typeof messages[key]).toBe("string")
      }
    }
  })

  it("dashboard 404 renders through t() (I18N-009)", () => {
    const source = readFileSync("apps/dashboard/app/not-found.tsx", "utf8")
    for (const literal of [
      "Head back to your dashboard",
      "Back to dashboard",
      '"Sign in"',
    ]) {
      expect(source).not.toContain(literal)
    }
    expect(source).toContain('tErrors("notFoundTitle")')
    expect(source).toContain('tErrors("notFoundDescription")')
    expect(source).toContain('tNav("backToDashboard")')
    expect(source).toContain('tAuth("signIn")')
    for (const locale of ["en", "ur"] as const) {
      const errors = JSON.parse(
        readFileSync(`packages/i18n/locales/${locale}/errors.json`, "utf8")
      ) as Record<string, string>
      expect(typeof errors.notFoundTitle).toBe("string")
      expect(typeof errors.notFoundDescription).toBe("string")
      const navigation = JSON.parse(
        readFileSync(
          `packages/i18n/locales/${locale}/dashboard/navigation.json`,
          "utf8"
        )
      ) as Record<string, string>
      expect(typeof navigation.backToDashboard).toBe("string")
    }
  })
})

describe("I18N-001–008 / I18N-201/202: the 74 missing keys are present", () => {
  // The 33 keys this stream added (the other 41 were already present
  // on base HEAD, fixed by Waves 5/6) — asserted in both locales so
  // a future edit cannot silently drop one side.
  const added: [string, string][] = [
    ["admin/plans", "entAiRequests"],
    ["admin/security", "all"],
    ["admin/security", "approveDescription"],
    ["admin/security", "approveTitle"],
    ["admin/security", "colActions"],
    ["admin/security", "eraseDeletes"],
    ["admin/security", "eraseDeletesList"],
    ["admin/security", "eraseKeeps"],
    ["admin/security", "eraseKeepsList"],
    ["admin/security", "next"],
    ["admin/security", "pageOf"],
    ["admin/security", "prev"],
    ["admin/security", "rejectDescription"],
    ["admin/security", "rejectTitle"],
    ["admin/security", "reviewSaved"],
    ["admin/settings", "emergencyNote"],
    ["admin/settings", "missing"],
    ["admin/settings", "off"],
    ["admin/settings", "on"],
    ["admin/settings", "set"],
    ["admin/settings", "unavailable"],
    ["admin/translations", "colActions"],
    ["admin/translations", "colApp"],
    ["admin/translations", "colCompletion"],
    ["admin/translations", "colDirection"],
    ["admin/translations", "comingSoon"],
    ["admin/translations", "complete"],
    ["admin/translations", "hideDomains"],
    ["admin/translations", "ltr"],
    ["admin/translations", "noLocales"],
    ["admin/translations", "rtl"],
    ["admin/translations", "showDomains"],
    ["admin/translations", "showMissing"],
  ]

  it.each(added)("locales/{en,ur}/%s.json contains %s", (domain, key) => {
    for (const locale of ["en", "ur"] as const) {
      const messages = JSON.parse(
        readFileSync(`packages/i18n/locales/${locale}/${domain}.json`, "utf8")
      ) as Record<string, string>
      expect(
        typeof messages[key],
        `${locale}/${domain}.json missing ${key}`
      ).toBe("string")
      expect(messages[key].length).toBeGreaterThan(0)
      // Urdu strings are real Urdu, never an English copy — except
      // direction abbreviations (LTR/RTL), which are identical by
      // design in both locales.
      if (locale === "ur" && key !== "ltr" && key !== "rtl") {
        expect(messages[key]).not.toBe(
          JSON.parse(
            readFileSync(`packages/i18n/locales/en/${domain}.json`, "utf8")
          )[key]
        )
      }
    }
  })

  it("the previously-fixed 41 keys are still present (no regression)", () => {
    const kept: [string, string][] = [
      ["admin/health", "aiCallsToday"],
      ["admin/health", "databaseTitle"],
      ["admin/health", "mcpKillSwitch"],
      ["admin/health", "outboxPending"],
      ["admin/submissions", "statsByStatus"],
      ["admin/submissions", "topFormsSpam"],
      ["admin/submissions", "searchLabel"],
      ["admin/subscriptions", "assignSubscription"],
      ["admin/subscriptions", "cancelAtPeriodEndLabel"],
      ["admin/subscriptions", "cancelSubscription"],
      ["admin/users", "roleAll"],
    ]
    for (const [domain, key] of kept) {
      for (const locale of ["en", "ur"] as const) {
        const messages = JSON.parse(
          readFileSync(`packages/i18n/locales/${locale}/${domain}.json`, "utf8")
        ) as Record<string, string>
        expect(typeof messages[key]).toBe("string")
      }
    }
  })
})
