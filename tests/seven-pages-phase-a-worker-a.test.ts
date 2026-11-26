// Phase A Worker A — All users rename (plan §3.2, Q1 = RENAME).
// The users list moved /admin/users → /admin/all-users; the old paths
// are thin redirects. No test here hits the real DB; these are static
// regression tests guarding the wiring (redirects, list parity, no
// stale page-route links, i18n keys, loading/error boundaries).
// The capability map + sidebar + tests/permissions.test.ts are
// coordinator-owned and intentionally NOT asserted here.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

// The 9 component files whose /admin/users page links were repointed.
const REPOINTED_FILES = [
  "apps/admin/components/admin/users-table.tsx",
  "apps/admin/components/admin/user-detail.tsx",
  "apps/admin/components/admin/ai-usage-table.tsx",
  "apps/admin/components/admin/mcp-keys-table.tsx",
  "apps/admin/components/admin/mcp-overview.tsx",
  "apps/admin/components/admin/platform-submissions.tsx",
  "apps/admin/components/admin/security-overview.tsx",
  "apps/admin/components/admin/support-queue.tsx",
  "apps/admin/components/admin/support-thread.tsx",
]

describe("All users rename — redirects", () => {
  it("keeps a thin /admin/users page that redirects to /admin/all-users", () => {
    const src = read("apps/admin/app/admin/users/page.tsx")
    expect(src).toContain("redirect(`/admin/all-users")
    expect(src).not.toContain("listUsers")
    expect(src).not.toContain("UsersTable")
  })

  it("carries the list query string over so filtered deep links survive", () => {
    const src = read("apps/admin/app/admin/users/page.tsx")
    expect(src).toContain("searchParams")
    expect(src).toContain("URLSearchParams")
  })

  it("keeps a thin /admin/users/[userId] page that redirects to the new detail path", () => {
    const src = read("apps/admin/app/admin/users/[userId]/page.tsx")
    expect(src).toContain("redirect(`/admin/all-users/${userId}`)")
    expect(src).not.toContain("getUserDetail")
    expect(src).not.toContain("UserDetail")
  })
})

describe("All users rename — list parity", () => {
  it("renders the same list at /admin/all-users (same service, table, filters)", () => {
    const src = read("apps/admin/app/admin/all-users/page.tsx")
    expect(src).toContain("listUsers")
    expect(src).toContain("AdminUserListQuerySchema")
    expect(src).toContain("UsersTable")
    expect(src).toContain("PageHeader")
    expect(src).toContain('getTranslator(locale, "users")')
    expect(src).toContain("initialData={initialData}")
    expect(src).toContain("filters={filters}")
  })

  it("keeps the same detail wiring at /admin/all-users/[userId]", () => {
    const src = read("apps/admin/app/admin/all-users/[userId]/page.tsx")
    expect(src).toContain("getUserDetail")
    expect(src).toContain("UserDetail")
    expect(src).toContain("getUserAiBillingMode")
    expect(src).toContain("getUserMcpSettings")
  })

  it("has no other files left under the old route dir", () => {
    expect(
      readdirSync(path.join(root, "apps/admin/app/admin/users")).sort()
    ).toEqual(["[userId]", "page.tsx"])
    expect(
      readdirSync(path.join(root, "apps/admin/app/admin/users/[userId]"))
    ).toEqual(["page.tsx"])
  })
})

describe("All users rename — no stale page-route links", () => {
  it("repoints every page link in the 9 touched components", () => {
    for (const file of REPOINTED_FILES) {
      const src = read(file)
      // Page-route hrefs only — /api/v1/admin/users/* API routes do not
      // move and must not match this check.
      expect(src, file).not.toContain('"/admin/users"')
      expect(src, file).not.toContain("`/admin/users/${")
      expect(src, file).toContain("/admin/all-users")
    }
  })

  it("points the detail back link at the new list", () => {
    expect(read("apps/admin/components/admin/user-detail.tsx")).toContain(
      'back={{ href: "/admin/all-users"'
    )
  })

  it("leaves the API routes under /api/v1/admin/users/* untouched", () => {
    expect(
      existsSync(path.join(root, "apps/api/app/api/v1/admin/users/route.ts"))
    ).toBe(true)
    expect(
      existsSync(
        path.join(root, "apps/api/app/api/v1/admin/users/[userId]/route.ts")
      )
    ).toBe(true)
  })
})

describe("All users rename — i18n", () => {
  it("has the allUsers nav key in en + ur (the sidebar label)", () => {
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").allUsers
    ).toBe("All users")
    expect(
      readJson("packages/i18n/locales/ur/admin/navigation.json").allUsers
    ).toBe("تمام صارفین")
  })

  it("keeps the users nav key in en + ur (do not delete)", () => {
    for (const locale of ["en", "ur"]) {
      const nav = readJson(
        `packages/i18n/locales/${locale}/admin/navigation.json`
      )
      expect(nav.users, `${locale}.users`).toBeDefined()
    }
  })

  it("reuses the users.json domain in en + ur (no new domain file)", () => {
    for (const locale of ["en", "ur"]) {
      const users = readJson(`packages/i18n/locales/${locale}/admin/users.json`)
      expect(users.title, `${locale}.users.title`).toBeDefined()
      expect(users.backToUsers, `${locale}.users.backToUsers`).toBeDefined()
    }
  })
})

describe("All users rename — loading + error boundaries", () => {
  it("adds loading.tsx + error.tsx for the new route (SRC-111 pattern)", () => {
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/all-users/loading.tsx"))
    ).toBe(true)
    expect(
      existsSync(path.join(root, "apps/admin/app/admin/all-users/error.tsx"))
    ).toBe(true)
    expect(read("apps/admin/app/admin/all-users/loading.tsx")).toContain(
      "Skeleton"
    )
    const error = read("apps/admin/app/admin/all-users/error.tsx")
    expect(error).toContain('"use client"')
    expect(error).toContain("createLogger")
    // SEC-107: generic message, never the error's own message.
    expect(error).not.toContain("error.message")
  })
})
