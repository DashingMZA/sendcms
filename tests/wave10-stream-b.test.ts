// Wave 10 Stream B — static regression tests for the dashboard
// patterns & cards findings (UX-101/102/103/104/105/106/107/108/109/
// 110/111/112/113/203/209/210/302, DSH-005, UX-006/014, SRC-111/118,
// PRF-040 dashboard part, UX-305 dashboard half). No test here hits
// the real DB; behaviour is proven by the SSR verification pass, these
// tests guard the wiring (shared components, nav rules, splits, and
// the absence of the removed patterns).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveActiveHref } from "../apps/dashboard/lib/nav-active"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

const SECTION_HEADING_CLASS =
  "text-sm font-semibold tracking-wider text-muted-foreground uppercase"

function walkTsx(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    // Build output must never be scanned (it mirrors source).
    if (entry === ".next" || entry === "node_modules" || entry === "dist")
      continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walkTsx(full, out)
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full)
  }
  return out
}

const DASHBOARD_FILES = walkTsx(path.join(root, "apps/dashboard/app")).concat(
  walkTsx(path.join(root, "apps/dashboard/components"))
)
const UI_SRC_FILES = walkTsx(path.join(root, "packages/ui/src"))
const ADMIN_FILES = walkTsx(path.join(root, "apps/admin"))

const DASHBOARD_HREFS = [
  "/dashboard",
  "/dashboard/domains",
  "/dashboard/forms",
  "/dashboard/inbox",
  "/dashboard/notifications",
  "/dashboard/analytics",
  "/dashboard/api",
  "/dashboard/api-keys",
  "/dashboard/ai",
  "/dashboard/support",
  "/dashboard/account",
  "/dashboard/billing",
]

describe("UX-101 — shared Card everywhere", () => {
  it("no hand-rolled section boxes remain in the dashboard", () => {
    const offenders = DASHBOARD_FILES.filter((file) =>
      readFileSync(file, "utf-8").includes("rounded-lg border p-4 sm:p-6")
    )
    expect(offenders).toEqual([])
  })
})

describe("UX-102 — StatCard on Card in @sendcms/ui", () => {
  it("the shared StatCard is built on Card with the admin value size", () => {
    const src = read("packages/ui/src/components/stat-card.tsx")
    expect(src).toContain("Card")
    expect(src).toContain("text-2xl")
    expect(src).toContain("font-semibold")
    // The old text-3xl value size must not survive in code (a doc
    // comment may still name it as the removed size).
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
    expect(code).not.toContain("text-3xl")
  })

  it("the old dashboard-local stat-card is gone", () => {
    expect(
      existsSync(
        path.join(root, "apps/dashboard/components/dashboard/stat-card.tsx")
      )
    ).toBe(false)
  })

  it("overview + analytics import StatCard from @sendcms/ui", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/(overview)/page.tsx",
      "apps/dashboard/app/dashboard/analytics/page.tsx",
    ]) {
      const src = read(rel)
      expect(src).toContain("StatCard")
      expect(src).toContain('from "@sendcms/ui"')
      expect(src).not.toContain("components/dashboard/stat-card")
    }
  })
})

describe("UX-103/210 — one content padding (PageContent)", () => {
  it("PageContent carries the single padding value", () => {
    const src = read("apps/dashboard/components/dashboard/page-content.tsx")
    expect(src).toContain("p-4 sm:p-6 lg:p-8")
  })

  it("no dashboard page carries its own padding wrapper", () => {
    const pageFiles = walkTsx(
      path.join(root, "apps/dashboard/app/dashboard")
    ).filter((file) => file.endsWith("page.tsx"))
    const offenders = pageFiles.filter((file) => {
      const src = readFileSync(file, "utf-8")
      return (
        src.includes('className="p-4 sm:p-6"') ||
        src.includes("gap-8 p-8") ||
        src.includes("flex max-w-md flex-col gap-6 p-6") ||
        src.includes("flex max-w-3xl flex-col gap-8 p-8")
      )
    })
    expect(offenders).toEqual([])
  })
})

describe("UX-104 — shared EmptyState", () => {
  it("the shared EmptyState exists with an optional CTA", () => {
    const src = read("packages/ui/src/components/empty-state.tsx")
    expect(src).toContain("empty-state")
    expect(src).toContain("cta?")
  })

  it("the dashboard uses it (no hand-rolled dashed empty boxes)", () => {
    const users = DASHBOARD_FILES.filter((file) =>
      readFileSync(file, "utf-8").includes("EmptyState")
    )
    // domains, forms, inbox, notifications, support, overview, analytics
    expect(users.length).toBeGreaterThanOrEqual(7)
    const dashedEmpty = DASHBOARD_FILES.filter((file) =>
      readFileSync(file, "utf-8").includes(
        "rounded-lg border border-dashed py-20"
      )
    )
    expect(dashedEmpty).toEqual([])
  })
})

describe("UX-105 — shared Tabs with tab semantics", () => {
  it("inbox + notifications filters use the shared Tabs primitive", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/inbox/inbox-table.tsx",
      "apps/dashboard/app/dashboard/notifications/email-jobs-table.tsx",
    ]) {
      const src = read(rel)
      expect(src).toContain("TabsList")
      expect(src).toContain("TabsTrigger")
      expect(src).not.toContain('variant={tab === key ? "default" : "ghost"}')
    }
  })
})

describe("UX-106/DSH-005/SRC-111 — skeletons mirror pages", () => {
  it("every dashboard section has a loading.tsx", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/account/loading.tsx",
      "apps/dashboard/app/dashboard/analytics/loading.tsx",
      "apps/dashboard/app/dashboard/api/loading.tsx",
      "apps/dashboard/app/dashboard/ai/loading.tsx",
      "apps/dashboard/app/dashboard/api-keys/loading.tsx",
      "apps/dashboard/app/dashboard/billing/(overview)/loading.tsx",
      "apps/dashboard/app/dashboard/domains/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/forms/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/inbox/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/notifications/loading.tsx",
      "apps/dashboard/app/dashboard/support/(list)/loading.tsx",
      "apps/dashboard/app/dashboard/(overview)/loading.tsx",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true)
    }
  })

  it("no dashboard-level loading.tsx (DSH-104: detail notFound() must 404)", () => {
    expect(
      existsSync(path.join(root, "apps/dashboard/app/dashboard/loading.tsx"))
    ).toBe(false)
  })

  it("the overview skeleton has no donut chart and no min-w-[280px]", () => {
    const src = read("apps/dashboard/app/dashboard/(overview)/loading.tsx")
    expect(src).not.toContain("size-36 rounded-full")
    expect(src).not.toContain("rounded-full size-36")
    expect(src).not.toContain("min-w-[280px]")
  })

  it("skeletons carry the h-16 header bar", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/(overview)/loading.tsx",
      "apps/dashboard/app/dashboard/ai/loading.tsx",
      "apps/dashboard/app/dashboard/api-keys/loading.tsx",
    ]) {
      expect(read(rel)).toContain("PageHeaderSkeleton")
    }
  })
})

describe("UX-107 — shared SectionHeading", () => {
  it("the raw section-heading class string lives only in section-heading.tsx", () => {
    const offenders = DASHBOARD_FILES.concat(UI_SRC_FILES).filter(
      (file) =>
        readFileSync(file, "utf-8").includes(SECTION_HEADING_CLASS) &&
        !file.endsWith("packages/ui/src/components/section-heading.tsx")
    )
    expect(offenders).toEqual([])
  })
})

describe("UX-108 — no text-step-* in the dashboard", () => {
  it("no text-step- class remains", () => {
    const offenders = DASHBOARD_FILES.filter((file) =>
      readFileSync(file, "utf-8").includes("text-step-")
    )
    expect(offenders).toEqual([])
  })
})

describe("UX-109 — Remix icons only in the dashboard", () => {
  it("no lucide-react imports remain in the owned files", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/inbox/inbox-search-input.tsx",
      "apps/dashboard/app/dashboard/inbox/inbox-table.tsx",
      "apps/dashboard/app/dashboard/inbox/submission-detail.tsx",
      "apps/dashboard/app/dashboard/domains/copy-field.tsx",
      "apps/dashboard/app/dashboard/domains/[domainId]/domain-detail.tsx",
      "apps/dashboard/components/dashboard/install-snippet.tsx",
      "apps/dashboard/app/dashboard/error.tsx",
      "apps/dashboard/components/dashboard/list-search-input.tsx",
    ]) {
      expect(read(rel)).not.toContain("lucide-react")
    }
  })
})

describe("UX-110 — PageHeader action slot", () => {
  it("support + api-keys carry their primary action in the slot", () => {
    // The support page lives in the (list) group (SRC-111) so its
    // loading.tsx does not also wrap [ticketId]/.
    expect(
      read("apps/dashboard/app/dashboard/support/(list)/page.tsx")
    ).toContain("action={")
    expect(
      read("apps/dashboard/app/dashboard/support/(list)/page.tsx")
    ).toContain("newTicket")
    expect(read("apps/dashboard/app/dashboard/api-keys/page.tsx")).toContain(
      'form="create-api-key-form"'
    )
    expect(
      read("apps/dashboard/app/dashboard/api-keys/api-keys-manager.tsx")
    ).toContain('id="create-api-key-form"')
    // The in-form submit is gone — the header button submits the form.
    expect(
      read("apps/dashboard/app/dashboard/api-keys/api-keys-manager.tsx")
    ).not.toContain('type="submit"')
  })

  it("support has no in-content New ticket duplicate", () => {
    const src = read("apps/dashboard/app/dashboard/support/support-list.tsx")
    expect(src).not.toContain('href="/dashboard/support/new"')
  })

  it("AI has no page-level action (PARTIAL by owner decision: Test/Save live per provider card and cannot be hoisted into one slot)", () => {
    expect(read("apps/dashboard/app/dashboard/ai/page.tsx")).not.toContain(
      "action={"
    )
  })
})

describe("UX-111 — row actions by action-count", () => {
  it("api-keys rows use a DropdownMenu; notifications Requeue is ghost", () => {
    const apiKeys = read(
      "apps/dashboard/app/dashboard/api-keys/api-keys-manager.tsx"
    )
    expect(apiKeys).toContain("DropdownMenu")
    const jobs = read(
      "apps/dashboard/app/dashboard/notifications/email-jobs-table.tsx"
    )
    expect(jobs).toContain('variant="ghost"')
  })
})

describe("UX-112/203 — warning/success tokens, no palette literals", () => {
  it("the tokens exist in both token files", () => {
    for (const rel of [
      "apps/dashboard/styles/design-tokens.css",
      "apps/admin/styles/design-tokens.css",
    ]) {
      const src = read(rel)
      for (const token of [
        "--warning:",
        "--warning-foreground:",
        "--success:",
        "--success-foreground:",
        "--color-warning",
        "--color-success",
      ]) {
        expect(src, `${rel} ${token}`).toContain(token)
      }
    }
  })

  it("no (amber|green|red|yellow)-[0-9] literals in dashboard, admin or ui", () => {
    const palette = /(amber|green|red|yellow)-[0-9]/
    const offenders = DASHBOARD_FILES.concat(UI_SRC_FILES, ADMIN_FILES).filter(
      (file) => palette.test(readFileSync(file, "utf-8"))
    )
    expect(offenders).toEqual([])
  })

  it("no border-amber-500/50 anywhere (the callout uses border-warning/50)", () => {
    const offenders = DASHBOARD_FILES.concat(UI_SRC_FILES, ADMIN_FILES).filter(
      (file) => readFileSync(file, "utf-8").includes("border-amber-500/50")
    )
    expect(offenders).toEqual([])
  })

  it("the shared callout is the one warning surface", () => {
    const src = read("packages/ui/src/components/callout.tsx")
    expect(src).toContain("border-warning/50")
    expect(src).toContain("bg-warning/5")
    expect(read("apps/dashboard/app/dashboard/ai/ai-manager.tsx")).toContain(
      "Callout"
    )
    expect(
      read("apps/dashboard/app/dashboard/api-keys/api-keys-manager.tsx")
    ).toContain("Callout")
  })
})

describe("UX-113 — sidebar Badge + non-dashed gate", () => {
  it("the sidebar uses the shared Badge, not a hand-rolled span", () => {
    const src = read("apps/dashboard/components/dashboard/app-sidebar.tsx")
    expect(src).toContain("<Badge")
    expect(src).not.toContain("ms-auto me-1 text-xs font-bold")
  })

  it("the domains/new gate is a Callout, not a dashed box", () => {
    const src = read("apps/dashboard/app/dashboard/domains/new/page.tsx")
    expect(src).toContain("Callout")
    expect(src).not.toContain("border-dashed")
  })
})

describe("UX-209 — low-priority columns hidden below md", () => {
  it("inbox hides Form + Origin; notifications hides Claim Age + Last Error", () => {
    const inbox = read("apps/dashboard/app/dashboard/inbox/inbox-table.tsx")
    expect(inbox.match(/hidden md:table-cell/g)?.length).toBeGreaterThanOrEqual(
      4
    )
    const jobs = read(
      "apps/dashboard/app/dashboard/notifications/email-jobs-table.tsx"
    )
    expect(jobs).toContain("hidden md:table-cell")
    expect(jobs).toContain("md:table-cell")
  })
})

describe("UX-302 — no Phase parentheticals in form copy", () => {
  it("en + ur forms.json contain no Phase/فیز", () => {
    for (const rel of [
      "packages/i18n/locales/en/dashboard/forms.json",
      "packages/i18n/locales/ur/dashboard/forms.json",
    ]) {
      const src = read(rel)
      expect(src).not.toContain("Phase")
      expect(src).not.toContain("فیز")
    }
  })
})

describe("UX-006 — sidebar_state cookie read server-side", () => {
  it("the dashboard layout reads the cookie and passes defaultOpen", () => {
    const src = read("apps/dashboard/app/dashboard/layout.tsx")
    expect(src).toContain("sidebar_state")
    expect(src).toContain("defaultOpen={")
  })
})

describe("UX-014 — collapsed sidebar logo", () => {
  it("the wordmark hides in icon mode and a compact mark shows", () => {
    const src = read("apps/dashboard/components/dashboard/app-sidebar.tsx")
    expect(src).toContain("group-data-[collapsible=icon]:hidden")
    expect(src).toContain("group-data-[collapsible=icon]:flex")
  })
})

describe("UX-305 dashboard half — one active nav item", () => {
  it("resolves the longest href on a segment boundary", () => {
    expect(resolveActiveHref("/dashboard/api-keys", DASHBOARD_HREFS)).toBe(
      "/dashboard/api-keys"
    )
    expect(resolveActiveHref("/dashboard/api", DASHBOARD_HREFS)).toBe(
      "/dashboard/api"
    )
    expect(resolveActiveHref("/dashboard", DASHBOARD_HREFS)).toBe("/dashboard")
    expect(resolveActiveHref("/dashboard/domains/abc", DASHBOARD_HREFS)).toBe(
      "/dashboard/domains"
    )
    expect(resolveActiveHref("/dashboard/forms/new", DASHBOARD_HREFS)).toBe(
      "/dashboard/forms"
    )
    // Not a segment boundary for /dashboard/api-keys — it must not
    // light the api-keys item. It IS under /dashboard, so the
    // overview item is the (only) match.
    expect(resolveActiveHref("/dashboard/api-keysx", DASHBOARD_HREFS)).toBe(
      "/dashboard"
    )
    expect(resolveActiveHref("/unrelated", DASHBOARD_HREFS)).toBe(null)
  })

  it("the sidebar uses resolveActiveHref", () => {
    expect(
      read("apps/dashboard/components/dashboard/app-sidebar.tsx")
    ).toContain("resolveActiveHref")
  })
})

describe("SRC-118 — form-detail + ai-manager splits", () => {
  it("the split files exist and each stays under 500 lines", () => {
    for (const rel of [
      "apps/dashboard/app/dashboard/forms/[formId]/form-detail.tsx",
      "apps/dashboard/app/dashboard/forms/[formId]/form-section.tsx",
      "apps/dashboard/app/dashboard/forms/[formId]/form-settings-section.tsx",
      "apps/dashboard/app/dashboard/forms/[formId]/form-domains-section.tsx",
      "apps/dashboard/app/dashboard/forms/[formId]/form-notifications-section.tsx",
      "apps/dashboard/app/dashboard/ai/ai-manager.tsx",
      "apps/dashboard/app/dashboard/ai/ai-browser-keys.ts",
      "apps/dashboard/app/dashboard/ai/ai-provider-key-card.tsx",
      "apps/dashboard/app/dashboard/ai/ai-storage-popup.tsx",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true)
      expect(read(rel).split("\n").length, rel).toBeLessThan(500)
    }
  })

  it("form-detail no longer defines the section components inline", () => {
    const src = read(
      "apps/dashboard/app/dashboard/forms/[formId]/form-detail.tsx"
    )
    expect(src).not.toContain("function DomainsSection")
    expect(src).not.toContain("function NotificationsSection")
    expect(src).not.toContain("function SettingsSection")
  })
})

describe("PRF-040 dashboard part — viewport + icons + manifest", () => {
  it("the root layout exports the media-qualified themeColor viewport", () => {
    const src = read("apps/dashboard/app/layout.tsx")
    expect(src).toContain("export const viewport: Viewport")
    // PRF-022 (Wave 11, Stream A): the light --primary token darkened
    // from oklch(0.6373 ...) to oklch(0.42 ...) for 4.5:1 contrast; the
    // light themeColor tracks the token, so it changed with it.
    expect(src).toContain("oklch(0.42 0.1362 162.517)")
    expect(src).toContain("oklch(0.7678 0.1655 162.189)")
    expect(src).toContain('manifest: "/manifest.webmanifest"')
    expect(src).toContain('apple: "/apple-touch-icon.png"')
  })

  it("the referenced assets exist in public/", () => {
    expect(
      existsSync(path.join(root, "apps/dashboard/public/manifest.webmanifest"))
    ).toBe(true)
    expect(
      existsSync(path.join(root, "apps/dashboard/public/apple-touch-icon.png"))
    ).toBe(true)
  })
})
