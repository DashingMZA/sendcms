// SRC-120 (Phase 16, Wave 12): the cross-app helpers were four copies
// that had already drifted in comments. `app-links` and the
// translation provider now have one source (`@sendcms/shared`,
// `@sendcms/ui`) with per-app re-exports; `language-selector` +
// `use-persist-locale` stay duplicated — they depend on each app's
// `@/lib/i18n-client`, so extracting them would drag that adapter
// along — and this test fails if the two copies drift apart.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  adminUrl,
  apiUrl,
  dashboardUrl,
  docsUrl,
  marketingTermsURL,
  marketingUrl,
  resolveLink,
  updatesUrl,
} from "@sendcms/shared"
import {
  LocaleProvider,
  TranslationProvider,
  useLocale,
  useTranslation,
} from "@sendcms/ui"
import * as marketingLinks from "../apps/marketing/lib/app-links"
import * as dashboardLinks from "../apps/dashboard/lib/app-links"
import * as docsLinks from "../apps/docs/lib/app-links"
import * as updatesLinks from "../apps/updates/lib/app-links"
import * as adminProviders from "../apps/admin/components/admin/translation-provider"
import * as dashboardProviders from "../apps/dashboard/components/dashboard/translation-provider"

const ROOT = join(import.meta.dirname, "..")

// The remaining duplicates differ only in their import paths and
// comments, so the comparison strips both and compares the bodies.
function normalizedBody(app: string, file: string): string {
  const text = readFileSync(
    join(ROOT, `apps/${app}/components/${app}/${file}`),
    "utf8"
  )
  const noImports = text.replace(/import[\s\S]*?from\s*["'][^"']*["']/g, "")
  const noComments = noImports
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "")
  return noComments
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n")
}

describe("SRC-120 — app-links has one source", () => {
  it("every per-app re-export is the shared function itself", () => {
    const expected = {
      adminUrl,
      apiUrl,
      dashboardUrl,
      docsUrl,
      marketingTermsURL,
      marketingUrl,
      resolveLink,
      updatesUrl,
    }
    for (const [name, links] of [
      ["marketing", marketingLinks],
      ["dashboard", dashboardLinks],
      ["docs", docsLinks],
      ["updates", updatesLinks],
    ] as const) {
      for (const [key, fn] of Object.entries(expected)) {
        expect(
          (links as Record<string, unknown>)[key],
          `${name}/lib/app-links.ts must re-export ${key} from @sendcms/shared`
        ).toBe(fn)
      }
    }
  })

  it("the shared helpers resolve the documented env vars and dev ports", () => {
    const prev = { ...process.env }
    try {
      delete process.env.NEXT_PUBLIC_API_URL
      delete process.env.NEXT_PUBLIC_APP_URL
      expect(apiUrl()).toBe("http://localhost:3001")
      expect(marketingUrl()).toBe("http://localhost:3000")
      expect(marketingTermsURL()).toBe("http://localhost:3000/terms")
      process.env.NEXT_PUBLIC_API_URL = "https://api.example.com/"
      expect(apiUrl()).toBe("https://api.example.com")
      expect(resolveLink("/sign-in")).toBe("http://localhost:3002/sign-in")
      expect(resolveLink("/changelog")).toBe("http://localhost:3004/changelog")
      expect(resolveLink("https://elsewhere.example/x")).toBe(
        "https://elsewhere.example/x"
      )
      expect(resolveLink("#anchor")).toBe("#anchor")
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prev)) delete process.env[key]
      }
      Object.assign(process.env, prev)
    }
  })
})

describe("SRC-120 — translation provider has one source", () => {
  it("both apps re-export the @sendcms/ui providers", () => {
    for (const [name, providers] of [
      ["admin", adminProviders],
      ["dashboard", dashboardProviders],
    ] as const) {
      expect(
        (providers as Record<string, unknown>).LocaleProvider,
        `${name} must re-export LocaleProvider from @sendcms/ui`
      ).toBe(LocaleProvider)
      expect(
        (providers as Record<string, unknown>).TranslationProvider,
        `${name} must re-export TranslationProvider from @sendcms/ui`
      ).toBe(TranslationProvider)
      expect(
        (providers as Record<string, unknown>).useLocale,
        `${name} must re-export useLocale from @sendcms/ui`
      ).toBe(useLocale)
      expect(
        (providers as Record<string, unknown>).useTranslation,
        `${name} must re-export useTranslation from @sendcms/ui`
      ).toBe(useTranslation)
    }
  })
})

describe("SRC-120 — remaining duplicates stay in sync", () => {
  it("language-selector bodies are identical across admin and dashboard", () => {
    expect(normalizedBody("dashboard", "language-selector.tsx")).toBe(
      normalizedBody("admin", "language-selector.tsx")
    )
  })

  it("use-persist-locale bodies are identical across admin and dashboard", () => {
    expect(normalizedBody("dashboard", "use-persist-locale.ts")).toBe(
      normalizedBody("admin", "use-persist-locale.ts")
    )
  })

  it("all three lib/auth.ts wrappers document the intentional 3-way duplication", () => {
    for (const app of ["api", "dashboard", "admin"]) {
      const text = readFileSync(join(ROOT, `apps/${app}/lib/auth.ts`), "utf8")
      expect(
        text,
        `${app}/lib/auth.ts must state the duplication is intentional`
      ).toContain("3-way duplication is intentional")
    }
  })
})
