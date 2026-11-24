/**
 * Phase 16, PRF-034 — the authenticated apps (dashboard, admin, api)
 * are fully disallowed to crawlers: a robots.txt that disallows
 * everything, `robots: { index: false, follow: false }` in the root
 * layout metadata (and on the not-found pages), plus the
 * `X-Robots-Tag` header in their next.config.mjs (asserted in
 * tests/security.test.ts).
 */
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const APPS = ["dashboard", "admin", "api"] as const

describe("robots.txt for the authenticated apps", () => {
  it("exists for dashboard, admin and api and disallows everything", () => {
    for (const app of APPS) {
      const path = `apps/${app}/app/robots.ts`
      expect(existsSync(path), path).toBe(true)
      const file = readFileSync(path, "utf8")
      expect(file).toContain('userAgent: "*"')
      expect(file).toContain('disallow: "/"')
    }
  })
})

describe("robots metadata for the authenticated apps", () => {
  it("sets index: false, follow: false in every root layout", () => {
    for (const app of APPS) {
      const file = readFileSync(`apps/${app}/app/layout.tsx`, "utf8")
      expect(file, `${app}/app/layout.tsx`).toContain(
        "robots: { index: false, follow: false }"
      )
    }
  })

  it("keeps the not-found pages noindex", () => {
    for (const app of APPS) {
      const file = readFileSync(`apps/${app}/app/not-found.tsx`, "utf8")
      expect(file, `${app}/app/not-found.tsx`).toContain(
        "robots: { index: false, follow: false }"
      )
    }
  })
})
