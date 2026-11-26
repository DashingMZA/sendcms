// Wave 10 Stream A — static regression tests for the admin shell &
// navigation findings (UX-001/002/005/006/007/008/009/012/013/014/015/
// 016/109/201/202/301/303/304/305/306, SRC-118, PRF-040 admin part).
// No test here hits the real DB; behaviour is proven by the SSR
// verification pass, these tests guard the wiring (locale strings,
// nav rules, splits, and the absence of the removed patterns).
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  getActiveNavHref,
  isActiveNavHref,
} from "../apps/admin/components/admin/nav-active"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

const ADMIN_HREFS = [
  "/admin",
  "/admin/users",
  "/admin/plans",
  "/admin/subscriptions",
  "/admin/usage",
  "/admin/billing",
  "/admin/submissions",
  "/admin/ai",
  "/admin/ai/providers",
  "/admin/ai/models",
  "/admin/ai/usage",
  "/admin/ai/settings",
  "/admin/mcp",
  "/admin/mcp/keys",
  "/admin/features",
  "/admin/announcements",
  "/admin/audit-logs",
  "/admin/support",
  "/admin/health",
  "/admin/security",
  "/admin/translations",
  "/admin/settings",
]

const ADMIN_ROUTES = [
  ...ADMIN_HREFS,
  "/admin/users/some-user-id",
  "/admin/plans/some-plan-id",
  "/admin/support/some-ticket-id",
  "/admin/subscriptions/migrate",
]

describe("UX-002 / UX-305 — one active nav item per route", () => {
  it("matches on a segment boundary, not a plain prefix", () => {
    expect(isActiveNavHref("/admin/mcp", "/admin/mcp/keys")).toBe(true)
    expect(isActiveNavHref("/admin/mcp/keys", "/admin/mcp/keys")).toBe(true)
    // The dashboard collision that motivated the boundary rule:
    // "/dashboard/api-keys" is NOT under "/dashboard/api".
    expect(isActiveNavHref("/dashboard/api", "/dashboard/api-keys")).toBe(false)
    expect(isActiveNavHref("/admin/ai", "/admin/ai/providers")).toBe(true)
    expect(isActiveNavHref("/admin", "/admin/users")).toBe(false)
    expect(isActiveNavHref("/admin", "/admin")).toBe(true)
  })

  it("picks the longest (most specific) match on every admin route", () => {
    for (const route of ADMIN_ROUTES) {
      const active = getActiveNavHref(ADMIN_HREFS, route)
      expect(active, `route ${route}`).toBeDefined()
      // The active href must be the longest matching href.
      const matches = ADMIN_HREFS.filter((href) => isActiveNavHref(href, route))
      expect(active).toBe(matches.sort((a, b) => b.length - a.length)[0])
    }
  })

  it("matches nothing on /admin/unauthorized (no nav entry there)", () => {
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/unauthorized")).toBeUndefined()
  })

  it("resolves the five formerly double-active pages to one item", () => {
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/ai/providers")).toBe(
      "/admin/ai/providers"
    )
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/ai/models")).toBe(
      "/admin/ai/models"
    )
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/ai/usage")).toBe(
      "/admin/ai/usage"
    )
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/ai/settings")).toBe(
      "/admin/ai/settings"
    )
    expect(getActiveNavHref(ADMIN_HREFS, "/admin/mcp/keys")).toBe(
      "/admin/mcp/keys"
    )
  })

  it("the sidebar uses the shared rule, not inline startsWith", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("getActiveNavHref")
    expect(sidebar).not.toContain("pathname.startsWith(item.href)")
  })
})

describe("UX-009 / UX-306 — AI overview + Integrations group", () => {
  it("has the new keys in en + ur and no reused 'ai' item label", () => {
    for (const locale of ["en", "ur"]) {
      const nav = readJson(
        `packages/i18n/locales/${locale}/admin/navigation.json`
      )
      expect(nav.aiOverview).toBeDefined()
      expect(nav.integrations).toBeDefined()
      expect(nav.mcpKeys).toBeDefined()
      expect(nav.goToDashboard).toBeDefined()
    }
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").aiOverview
    ).toBe("AI overview")
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").integrations
    ).toBe("Integrations")
    expect(
      readJson("packages/i18n/locales/en/admin/navigation.json").mcpKeys
    ).toBe("MCP keys")
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain('t("aiOverview")')
    expect(sidebar).toContain('t("integrations")')
    expect(sidebar).toContain('t("mcpKeys")')
    // The old "API keys" nav key is gone; the group label keeps t("ai").
    expect(sidebar).not.toContain('t("apiKeys")')
    expect(sidebar.match(/label: t\("ai"\)/g)?.length).toBe(1)
  })

  it("keeps en/ur navigation keys in sync", () => {
    const en = readJson("packages/i18n/locales/en/admin/navigation.json")
    const ur = readJson("packages/i18n/locales/ur/admin/navigation.json")
    expect(Object.keys(en).sort()).toEqual(Object.keys(ur).sort())
  })
})

describe("UX-307 — REVERSED: the 7 nav keys are retained", () => {
  it("keeps all 7 keys in en + ur (pages to be built separately)", () => {
    for (const locale of ["en", "ur"]) {
      const nav = readJson(
        `packages/i18n/locales/${locale}/admin/navigation.json`
      )
      for (const key of [
        "activity",
        "allUsers",
        "coupons",
        "jobs",
        "payments",
        "plansAndSubscriptions",
        "trials",
      ]) {
        expect(nav[key], `${locale}.${key}`).toBeDefined()
      }
    }
  })
})

describe("UX-012 — distinct icons per nav item", () => {
  it("gives AI usage and AI settings their own icons", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("RiLineChartLine")
    expect(sidebar).toContain("RiToolsLine")
    // Usage keeps the bar chart, Settings keeps the gear — each used once.
    expect(sidebar.match(/icon: RiBarChartLine/g)?.length).toBe(1)
    expect(sidebar.match(/icon: RiSettings3Line/g)?.length).toBe(1)
    expect(sidebar.match(/icon: RiLineChartLine/g)?.length).toBe(1)
    expect(sidebar.match(/icon: RiToolsLine/g)?.length).toBe(1)
  })
})

describe("UX-013 / UX-006 — badges + persisted collapse state", () => {
  it("feeds both badge counts from the layout", () => {
    const layout = read("apps/admin/app/admin/layout.tsx")
    expect(layout).toContain("countNewTickets")
    expect(layout).toContain("listDeletionRequests")
    expect(layout).toContain("pendingDeletionCount")
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("pendingDeletionCount")
    expect(sidebar).toContain("badge: pendingDeletionCount")
    expect(sidebar).toContain("badge: newTicketCount")
  })

  it("reads the sidebar_state cookie and passes defaultOpen", () => {
    const layout = read("apps/admin/app/admin/layout.tsx")
    expect(layout).toContain('get("sidebar_state")')
    expect(layout).toContain('defaultOpen={sidebarState !== "false"}')
  })
})

describe("UX-014 / UX-015 / UX-016 — collapsed logo, dashboard link, role", () => {
  it("hides the wordmark in icon mode and shows a compact mark", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("group-data-[collapsible=icon]:hidden")
    expect(sidebar).toContain("group-data-[collapsible=icon]:flex")
    expect(sidebar).toContain("logo_text.charAt(0)")
  })

  it("links the user menu to the customer dashboard", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("dashboardURL()")
    expect(sidebar).toContain('t("goToDashboard")')
  })

  it("shows the actor's role in the footer user block", () => {
    const sidebar = read("apps/admin/components/admin/app-sidebar.tsx")
    expect(sidebar).toContain("roleLabel")
    expect(sidebar).toContain("adminRole")
    expect(sidebar).toContain("platformRole")
    for (const locale of ["en", "ur"]) {
      const users = readJson(`packages/i18n/locales/${locale}/admin/users.json`)
      for (const key of [
        "roleSuperAdmin",
        "roleManager",
        "roleSupport",
        "roleNone",
        "platformOwner",
        "platformUser",
      ]) {
        expect(users[key], `${locale}.${key}`).toBeDefined()
      }
    }
  })
})

describe("UX-005 / UX-001 / UX-201 — shared admin PageHeader", () => {
  it("exists, renders the SidebarTrigger, and takes a back link", () => {
    const header = read("apps/admin/components/admin/page-header.tsx")
    expect(header).toContain("SidebarTrigger")
    expect(header).toContain("back?: { href: string; label: string }")
    expect(header).toContain("<h1")
  })

  it("is used by every admin list page", () => {
    const pages = [
      "apps/admin/app/admin/page.tsx",
      "apps/admin/app/admin/users/page.tsx",
      "apps/admin/app/admin/plans/page.tsx",
      "apps/admin/app/admin/subscriptions/page.tsx",
      "apps/admin/app/admin/subscriptions/migrate/page.tsx",
      "apps/admin/app/admin/usage/page.tsx",
      "apps/admin/app/admin/billing/page.tsx",
      "apps/admin/app/admin/submissions/page.tsx",
      "apps/admin/app/admin/ai/page.tsx",
      "apps/admin/app/admin/ai/providers/page.tsx",
      "apps/admin/app/admin/ai/models/page.tsx",
      "apps/admin/app/admin/ai/usage/page.tsx",
      "apps/admin/app/admin/ai/settings/page.tsx",
      "apps/admin/app/admin/mcp/page.tsx",
      "apps/admin/app/admin/mcp/keys/page.tsx",
      "apps/admin/app/admin/features/page.tsx",
      "apps/admin/app/admin/announcements/page.tsx",
      "apps/admin/app/admin/audit-logs/page.tsx",
      "apps/admin/app/admin/support/page.tsx",
      "apps/admin/app/admin/support/[ticketId]/page.tsx",
      "apps/admin/app/admin/health/page.tsx",
      "apps/admin/app/admin/security/page.tsx",
      "apps/admin/app/admin/translations/page.tsx",
      "apps/admin/app/admin/settings/page.tsx",
      "apps/admin/app/admin/unauthorized/page.tsx",
    ]
    for (const page of pages) {
      const src = read(page)
      expect(src, page).toContain("PageHeader")
      expect(src, page).not.toContain(
        '<h1 className="text-2xl font-bold tracking-tight">'
      )
    }
    // Detail pages render their header inside the detail component.
    expect(read("apps/admin/components/admin/user-detail.tsx")).toContain(
      "PageHeader"
    )
    expect(read("apps/admin/components/admin/plan-detail.tsx")).toContain(
      "PageHeader"
    )
  })
})

describe("UX-008 — one back-link pattern (PageHeader back prop)", () => {
  it("passes back links from the detail/sub pages", () => {
    expect(read("apps/admin/components/admin/user-detail.tsx")).toContain(
      'back={{ href: "/admin/users"'
    )
    expect(read("apps/admin/components/admin/plan-detail.tsx")).toContain(
      'back={{ href: "/admin/plans"'
    )
    expect(read("apps/admin/app/admin/support/[ticketId]/page.tsx")).toContain(
      'back={{ href: "/admin/support"'
    )
    expect(
      read("apps/admin/app/admin/subscriptions/migrate/page.tsx")
    ).toContain('back={{ href: "/admin/subscriptions"')
    // The old plain-text support back link is gone.
    expect(
      read("apps/admin/components/admin/support-thread.tsx")
    ).not.toContain('← {t("backToQueue")}')
  })
})

describe("UX-007 — MCP keys page h1/title say 'MCP keys'", () => {
  it("renames keysTitle in en + ur", () => {
    expect(readJson("packages/i18n/locales/en/admin/mcp.json").keysTitle).toBe(
      "MCP keys"
    )
    expect(readJson("packages/i18n/locales/ur/admin/mcp.json").keysTitle).toBe(
      "MCP کلیدیں"
    )
  })
})

describe("UX-301 / UX-303 — no phase language in the admin strings", () => {
  it("rewrites mcpNote and requestDeletionDescription in en + ur", () => {
    for (const locale of ["en", "ur"]) {
      const users = readJson(`packages/i18n/locales/${locale}/admin/users.json`)
      expect(users.mcpNote).not.toMatch(/Phase|فیز/i)
      expect(users.requestDeletionDescription).not.toMatch(/Phase|فیز|مرحلے/i)
    }
    const en = readJson("packages/i18n/locales/en/admin/users.json")
    expect(en.requestDeletionDescription).toContain("Security page")
    const ur = readJson("packages/i18n/locales/ur/admin/users.json")
    expect(ur.requestDeletionDescription).toContain("سیکیورٹی")
  })
})

describe("UX-304 — dead planned-sections apparatus removed", () => {
  it("deletes PlannedSection and has no dead dashboard.json keys", () => {
    expect(
      existsSync(
        path.join(root, "apps/admin/components/admin/planned-section.tsx")
      )
    ).toBe(false)
    for (const locale of ["en", "ur"]) {
      const dashboard = readJson(
        `packages/i18n/locales/${locale}/admin/dashboard.json`
      )
      for (const key of [
        "overviewDescription",
        "phase",
        "comingSoonDescription",
        "plannedSections",
        "plannedSectionsDescription",
      ]) {
        expect(dashboard[key], `${locale}.${key}`).toBeUndefined()
      }
    }
    expect(
      read("apps/admin/components/admin/overview-dashboard.tsx")
    ).not.toContain("PlannedSection")
  })
})

describe("UX-109 — Remix icons only in the 5 admin files", () => {
  it("has no lucide-react imports left in the admin files", () => {
    for (const file of [
      "apps/admin/components/admin/users-table.tsx",
      "apps/admin/components/admin/plans-table.tsx",
      "apps/admin/components/admin/subscriptions-table.tsx",
      "apps/admin/components/admin/subscriptions-table/subscription-dialogs.tsx",
      "apps/admin/components/admin/subscriptions-table/subscriptions-search-input.tsx",
      "apps/admin/components/admin/migration-wizard.tsx",
      "apps/admin/components/admin/usage-overview.tsx",
    ]) {
      expect(read(file), file).not.toContain("lucide-react")
    }
  })
})

describe("UX-202 — wide dialogs use the sm: arbitrary max-width", () => {
  it("replaces max-w-2xl with sm:max-w-[42rem] at the 4 sites", () => {
    const sites: Array<[string, string]> = [
      [
        "apps/admin/components/admin/user-detail/user-submissions-tab.tsx",
        "sm:max-w-[42rem]",
      ],
      [
        "apps/admin/components/admin/plan-detail/plan-dialogs.tsx",
        "sm:max-w-[42rem]",
      ],
      ["apps/admin/components/admin/plans-table.tsx", "sm:max-w-[42rem]"],
      [
        "apps/admin/components/admin/subscriptions-table/subscription-dialogs.tsx",
        "sm:max-w-[42rem]",
      ],
    ]
    for (const [file, wide] of sites) {
      const src = read(file)
      expect(src, file).toContain(wide)
      expect(src, file).not.toContain("max-w-2xl")
    }
  })
})

describe("SRC-118 — one file per tab/concern", () => {
  it("splits the three god components below 400 lines each", () => {
    for (const file of [
      "apps/admin/components/admin/user-detail.tsx",
      "apps/admin/components/admin/plan-detail.tsx",
      "apps/admin/components/admin/subscriptions-table.tsx",
    ]) {
      const lines = read(file).split("\n").length
      expect(lines, file).toBeLessThan(400)
    }
  })

  it("has one file per user-detail tab", () => {
    const dir = path.join(root, "apps/admin/components/admin/user-detail")
    for (const file of [
      "shared.tsx",
      "user-profile-tab.tsx",
      "user-forms-tab.tsx",
      "user-domains-tab.tsx",
      "user-submissions-tab.tsx",
      "user-audit-tab.tsx",
      "user-mcp-keys-card.tsx",
      "user-action-dialog.tsx",
    ]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    }
  })

  it("has one file per plan-detail concern", () => {
    const dir = path.join(root, "apps/admin/components/admin/plan-detail")
    for (const file of [
      "entitlements-table.tsx",
      "version-compare.tsx",
      "plan-dialogs.tsx",
    ]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    }
    // Re-exports keep existing import sites working.
    expect(read("apps/admin/components/admin/plan-detail.tsx")).toContain(
      "export { EntitlementsTable }"
    )
  })

  it("has one file per subscriptions-table concern", () => {
    const dir = path.join(
      root,
      "apps/admin/components/admin/subscriptions-table"
    )
    for (const file of [
      "subscriptions-search-input.tsx",
      "subscription-dialogs.tsx",
    ]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    }
    expect(
      read("apps/admin/components/admin/subscriptions-table.tsx")
    ).toContain("export { AssignDialog, CancelDialog }")
    expect(readdirSync(dir).sort()).toEqual([
      "subscription-dialogs.tsx",
      "subscriptions-search-input.tsx",
    ])
  })
})

describe("PRF-040 — admin viewport + touch icon + manifest", () => {
  it("exports the media-qualified themeColor pair and links the assets", () => {
    const layout = read("apps/admin/app/layout.tsx")
    expect(layout).toContain("export const viewport: Viewport")
    expect(layout).toContain("oklch(0.6373 0.1362 162.517)")
    expect(layout).toContain("oklch(0.7678 0.1655 162.189)")
    expect(layout).toContain("(prefers-color-scheme: light)")
    expect(layout).toContain("(prefers-color-scheme: dark)")
    expect(layout).toContain('rel="apple-touch-icon"')
    expect(layout).toContain('href="/apple-touch-icon.png"')
    expect(layout).toContain('rel="manifest"')
    expect(layout).toContain('href="/manifest.webmanifest"')
  })
})
