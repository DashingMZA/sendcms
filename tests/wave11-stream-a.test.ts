// Wave 11, Stream A — accessibility / landmarks / contrast / keyboard.
//
// Static (source-level) regression tests plus a real WCAG contrast
// computation over the shared design tokens. Live SSR/browser checks
// are owner-side (Phase 17); these tests pin the source facts the live
// checks depend on so a later edit fails here first.
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

function filesUnder(rel: string, suffix = ".tsx"): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") walk(full)
      } else if (entry.name.endsWith(suffix)) {
        out.push(full)
      }
    }
  }
  walk(path.join(ROOT, rel))
  return out.sort()
}

// ---------------------------------------------------------------------------
// Design tokens: WCAG contrast (PRF-022/024/025)
// ---------------------------------------------------------------------------

function parseOklch(value: string): [number, number, number] {
  const m = value
    .trim()
    .match(/oklch\(\s*([0-9.]+)%?\s+([0-9.]+)\s+([0-9.]+)\s*\)/)
  if (!m) throw new Error(`cannot parse oklch: ${value}`)
  let L = parseFloat(m[1])
  if (
    value
      .split("(")[1]
      .trim()
      .startsWith(m[1] + "%")
  )
    L /= 100
  return [L, parseFloat(m[2]), parseFloat(m[3])]
}

function oklchToSrgb(
  L: number,
  C: number,
  hDeg: number
): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = L + 0.3963377774 * a + 0.2158037573 * b
  const m = L - 0.1055613458 * a - 0.0638541728 * b
  const s = L - 0.0894841775 * a - 1.291485548 * b
  const l3 = l ** 3
  const m3 = m ** 3
  const s3 = s ** 3
  const toSrgb = (c: number) => {
    const v = Math.max(0, Math.min(1, c))
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return [
    toSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    toSrgb(-1.2684380046 * l3 + 2.6097574013 * m3 - 0.3413193965 * s3),
    toSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ]
}

function luminance(rgb: [number, number, number]): number {
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const [r, g, b] = rgb.map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(
  fg: [number, number, number],
  bg: [number, number, number]
): number {
  const hi = Math.max(luminance(fg), luminance(bg))
  const lo = Math.min(luminance(fg), luminance(bg))
  return (hi + 0.05) / (lo + 0.05)
}

function blend(
  fg: [number, number, number],
  bg: [number, number, number],
  alpha: number
): [number, number, number] {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ]
}

type TokenMap = Record<string, [number, number, number]>

function loadTokens(rel: string): { light: TokenMap; dark: TokenMap } {
  const text = read(rel)
  const parseBlock = (block: string): TokenMap => {
    const out: TokenMap = {}
    for (const [, name, value] of block.matchAll(
      /--([\w-]+):\s*(oklch\([^)]+\));/g
    )) {
      out[name] = oklchToSrgb(...parseOklch(value))
    }
    return out
  }
  const [lightBlock, darkBlock] = text.split(".dark")
  return {
    light: parseBlock(lightBlock),
    dark: parseBlock(darkBlock.split("@theme")[0]),
  }
}

// [label, foreground token, background token | blended background, bar]
// Every pair here is rendered by a real component (verified by grep at
// fix time). Latent pairs no component renders (solid destructive
// button, solid sidebar-primary button, warning/success foreground on
// its own solid colour, the generic --border) are NOT asserted: a
// single token cannot satisfy both text directions for them at once.
const TEXT_PAIRS: Array<
  [
    string,
    string,
    string | { token: string; alpha: number; over: string },
    number,
  ]
> = [
  ["primary button text", "primary-foreground", "primary", 4.5],
  [
    "primary button hover",
    "primary-foreground",
    { token: "primary", alpha: 0.8, over: "background" },
    4.5,
  ],
  ["primary link text on background", "primary", "background", 4.5],
  ["primary link text on card", "primary", "card", 4.5],
  ["muted text on background", "muted-foreground", "background", 4.5],
  ["muted text on muted", "muted-foreground", "muted", 4.5],
  ["muted text on sidebar", "muted-foreground", "sidebar", 4.5],
  ["muted text on card", "muted-foreground", "card", 4.5],
  ["avatar initials (muted)", "muted-foreground", "muted", 4.5],
  [
    "avatar initials (sidebar-primary)",
    "sidebar-primary",
    { token: "sidebar-primary", alpha: 0.1, over: "sidebar" },
    4.5,
  ],
  ["destructive text on background", "destructive", "background", 4.5],
  ["destructive text on card", "destructive", "card", 4.5],
  [
    "destructive button",
    "destructive",
    { token: "destructive", alpha: 0.1, over: "background" },
    4.5,
  ],
  [
    "destructive button (dark tint)",
    "destructive",
    { token: "destructive", alpha: 0.2, over: "background" },
    4.5,
  ],
  ["body text", "foreground", "background", 4.5],
  ["card text", "card-foreground", "card", 4.5],
  ["secondary text", "secondary-foreground", "secondary", 4.5],
  ["accent text", "accent-foreground", "accent", 4.5],
  ["sidebar text", "sidebar-foreground", "sidebar", 4.5],
  ["sidebar accent text", "sidebar-accent-foreground", "sidebar-accent", 4.5],
  ["warning text", "warning", "background", 4.5],
  [
    "warning badge",
    "warning-foreground",
    { token: "warning", alpha: 0.1, over: "background" },
    4.5,
  ],
  ["success text", "success", "background", 4.5],
  [
    "success badge",
    "success-foreground",
    { token: "success", alpha: 0.1, over: "background" },
    4.5,
  ],
  ["popover text", "popover-foreground", "popover", 4.5],
  ["input border vs background (non-text 3:1)", "input", "background", 3.0],
]

const TOKEN_FILES = [
  "apps/admin/styles/design-tokens.css",
  "apps/dashboard/styles/design-tokens.css",
  "apps/docs/styles/design-tokens.css",
  "apps/marketing/styles/design-tokens.css",
  "apps/updates/styles/design-tokens.css",
]

describe("design tokens (PRF-022/024/025)", () => {
  it("the five apps share one identical token file", () => {
    const first = read(TOKEN_FILES[0])
    for (const file of TOKEN_FILES.slice(1)) {
      expect(read(file)).toBe(first)
    }
  })

  it("every text-carrying pair meets its WCAG bar in light and dark", () => {
    for (const file of TOKEN_FILES.slice(0, 1)) {
      const { light, dark } = loadTokens(file)
      for (const [theme, tokens] of Object.entries({ light, dark }) as Array<
        [string, TokenMap]
      >) {
        for (const [label, fg, bg, bar] of TEXT_PAIRS) {
          const bgRgb =
            typeof bg === "string"
              ? tokens[bg]
              : blend(tokens[bg.token], tokens[bg.over], bg.alpha)
          const ratio = contrast(tokens[fg], bgRgb)
          expect(
            ratio,
            `${theme} ${label}: ${ratio.toFixed(2)}:1 < ${bar}:1`
          ).toBeGreaterThanOrEqual(bar)
        }
      }
    }
  })

  it("honours prefers-reduced-motion (PRF-029)", () => {
    for (const file of TOKEN_FILES) {
      expect(read(file)).toContain("@media (prefers-reduced-motion: reduce)")
    }
  })
})

// ---------------------------------------------------------------------------
// Landmarks / skip link (PRF-021, UX-003, PRF-026)
// ---------------------------------------------------------------------------

describe("landmarks and skip link", () => {
  const sidebar = read("packages/ui/src/components/sidebar.tsx")

  it("SidebarInset is the single <main id=main-content> (PRF-021)", () => {
    expect(sidebar).toContain('id="main-content"')
    expect(sidebar).toMatch(/function SidebarInset[\s\S]*?<main/)
  })

  it("SidebarMenuButton exposes the active item (UX-004)", () => {
    expect(sidebar).toContain('aria-current={isActive ? "page" : undefined}')
  })

  it("SidebarContent renders a <nav> when labelled (PRF-026)", () => {
    expect(sidebar).toContain("<nav")
    expect(
      read("apps/dashboard/components/dashboard/app-sidebar.tsx")
    ).toContain('<SidebarContent aria-label="Dashboard">')
    expect(read("apps/admin/components/admin/app-sidebar.tsx")).toContain(
      '<SidebarContent aria-label="Admin">'
    )
  })

  it("admin pages inside the sidebar have no nested <main> (UX-003)", () => {
    // File-level: no <main>, and NO per-page #main-content at all. The
    // single skip target comes from SidebarInset; a page that carried its
    // own <div id="main-content"> duplicated the id in the rendered page
    // (consolidation live probe: 3 occurrences in the streamed /admin
    // HTML — SidebarInset <main> + loading fallback + page content — and
    // 2 in the live DOM). PRF-021's finding warned about exactly this
    // duplicate, so the per-page ids were removed in consolidation and
    // SidebarInset owns the one target. Pages either render content or
    // are redirect stubs; the detail components render content too.
    const files = [
      ...filesUnder("apps/admin/app/admin").filter((f) =>
        f.endsWith("/page.tsx")
      ),
      ...filesUnder("apps/admin/app/admin").filter(
        (f) => f.endsWith("/loading.tsx") || f.endsWith("/error.tsx")
      ),
    ]
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text, file).not.toContain("<main")
      expect(text, file).not.toContain("</main>")
      expect(
        text.match(/id="main-content"/g) ?? [],
        `${file}: no per-page #main-content (SidebarInset owns it)`
      ).toHaveLength(0)
    }
    // The detail components render inside SidebarInset too.
    for (const file of [
      "apps/admin/components/admin/user-detail.tsx",
      "apps/admin/components/admin/plan-detail.tsx",
    ]) {
      const text = read(file)
      expect(text, file).not.toContain("<main")
      expect(
        text.match(/id="main-content"/g) ?? [],
        `${file}: no per-page #main-content (SidebarInset owns it)`
      ).toHaveLength(0)
    }
  })

  it("auth pages and the demo page have their own <main> (PRF-021)", () => {
    expect(read("apps/dashboard/app/(auth)/auth-shell.tsx")).toContain(
      '<main\n        id="main-content"'
    )
    // Stream C moved the form into demo-form.tsx and kept the <main>.
    expect(read("apps/marketing/app/demo/contact-us/demo-form.tsx")).toContain(
      'id="main-content"'
    )
    expect(read("apps/dashboard/app/page.tsx")).toContain('id="main-content"')
  })

  it("both app layouts render a skip link to #main-content", () => {
    expect(read("apps/dashboard/app/layout.tsx")).toContain(
      'href="#main-content"'
    )
    expect(read("apps/admin/app/layout.tsx")).toContain('href="#main-content"')
  })

  it("the logo is a single link, not a button wrapping a link (UX-010)", () => {
    for (const file of [
      "apps/dashboard/components/dashboard/app-sidebar.tsx",
      "apps/admin/components/admin/app-sidebar.tsx",
    ]) {
      const text = read(file)
      // The header menu button renders the link directly (asChild).
      expect(text, file).toMatch(
        /<SidebarMenuButton\s*\n\s*size="lg"\s*\n\s*asChild/
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Headings (UX-011)
// ---------------------------------------------------------------------------

describe("headings (UX-011)", () => {
  it("CardTitle accepts a heading element", () => {
    const card = read("packages/ui/src/components/card.tsx")
    expect(card).toContain('as?: "div" | "h2" | "h3"')
  })

  it("admin section cards render their title as <h2>", () => {
    const files = filesUnder("apps/admin/components/admin").filter((f) =>
      readFileSync(f, "utf8").includes("<CardTitle")
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text, file).not.toMatch(/<CardTitle(?! as="h2")/)
    }
  })
})

// ---------------------------------------------------------------------------
// Inbox keyboard path (PRF-023)
// ---------------------------------------------------------------------------

describe("inbox keyboard path (PRF-023)", () => {
  it("the sender cell is a real link to the submission", () => {
    const text = read("apps/dashboard/app/dashboard/inbox/inbox-table.tsx")
    expect(text).toContain("href={`/dashboard/inbox/${item.id}`}")
    expect(text).toContain("<Link")
  })
})

// ---------------------------------------------------------------------------
// Labels and target size (PRF-027, PRF-030)
// ---------------------------------------------------------------------------

describe("labels and target size (PRF-027/PRF-030)", () => {
  it("the shared SearchInput labels the field and sizes the clear button", () => {
    const text = read("packages/ui/src/components/search-input.tsx")
    expect(text).toContain('<Label htmlFor={id} className="sr-only">')
    // The clear button is 24 px (size-6); the search icon stays 16 px.
    expect(text).toContain("flex size-6 -translate-y-1/2")
    expect(text).not.toContain("absolute end-2.5 top-1/2 size-4")
  })

  it("every search site renders the shared SearchInput", () => {
    for (const file of [
      "apps/dashboard/app/dashboard/inbox/inbox-search-input.tsx",
      "apps/dashboard/components/dashboard/list-search-input.tsx",
      "apps/admin/components/admin/users-table.tsx",
      "apps/admin/components/admin/plans-table.tsx",
      "apps/admin/components/admin/subscriptions-table/subscriptions-search-input.tsx",
      "apps/admin/components/admin/support-queue.tsx",
      "apps/admin/components/admin/usage-overview.tsx",
    ]) {
      expect(read(file), file).toContain("SearchInput")
    }
  })

  it("no 16px search-clear button remains", () => {
    const files = filesUnder("apps/dashboard/app/dashboard/inbox")
      .concat(filesUnder("apps/dashboard/components/dashboard"))
      .concat(filesUnder("apps/admin/components/admin"))
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      expect(text, file).not.toMatch(
        /className="absolute end-2\.5 top-1\/2 size-4 /
      )
    }
  })

  it("the filter selects and the AI prompt textarea are labelled", () => {
    expect(
      read("apps/dashboard/app/dashboard/domains/[domainId]/domain-detail.tsx")
    ).toContain('aria-label={t("methodLabel")}')
    expect(
      read("apps/dashboard/app/dashboard/support/support-list.tsx")
    ).toContain('aria-label={t("colStatus")}')
    const queue = read("apps/admin/components/admin/support-queue.tsx")
    expect(queue).toContain('aria-label={t("filterStatus")}')
    expect(queue).toContain('aria-label={t("filterPriority")}')
    expect(queue).toContain('aria-label={t("filterAssignee")}')
    const fields = read(
      "apps/dashboard/app/dashboard/forms/[formId]/fields-section.tsx"
    )
    expect(fields).toContain('<Label htmlFor="ai-prompt" className="sr-only">')
    expect(fields).toContain('id="ai-prompt"')
  })
})

// ---------------------------------------------------------------------------
// Focus management (PRF-028)
// ---------------------------------------------------------------------------

describe("focus management (PRF-028)", () => {
  it("route changes move focus to #main-content", () => {
    const focus = read(
      "packages/ui/src/components/focus-main-on-route-change.tsx"
    )
    expect(focus).toContain('getElementById("main-content")')
    expect(focus).toContain(".focus(")
    for (const file of [
      "apps/dashboard/app/layout.tsx",
      "apps/admin/app/layout.tsx",
    ]) {
      expect(read(file), file).toContain("<FocusMainOnRouteChange />")
    }
    expect(read("packages/ui/src/components/sidebar.tsx")).toContain(
      "tabIndex={-1}"
    )
  })

  it("failed submits mark the field and move focus to it", () => {
    for (const file of [
      "apps/dashboard/app/(auth)/sign-in/email-sign-in-form.tsx",
      "apps/dashboard/app/dashboard/account/change-email-form.tsx",
    ]) {
      const text = read(file)
      expect(text, file).toContain("aria-invalid={errorField")
      expect(text, file).toContain("aria-describedby")
      expect(text, file).toContain('role="alert"')
      expect(text, file).toMatch(/\.current\?\.focus\(\)/)
    }
  })
})

// ---------------------------------------------------------------------------
// Metadata (SRC-113, PRF-037)
// ---------------------------------------------------------------------------

describe("metadata (SRC-113/PRF-037)", () => {
  const dashboardPages = filesUnder("apps/dashboard/app/dashboard").filter(
    (f) => f.endsWith("/page.tsx")
  )
  const authPages = filesUnder("apps/dashboard/app/(auth)").filter((f) =>
    f.endsWith("/page.tsx")
  )

  it("all 20 dashboard pages export metadata", () => {
    expect(dashboardPages).toHaveLength(20)
    for (const file of dashboardPages) {
      const text = readFileSync(file, "utf8")
      expect(text, file).toMatch(
        /export (async function generateMetadata|const metadata)/
      )
    }
  })

  it("all 5 auth pages export metadata with distinct titles", () => {
    expect(authPages).toHaveLength(5)
    const titles = authPages.map((file) => {
      const text = readFileSync(file, "utf8")
      const m = text.match(
        /export const metadata: Metadata = \{[\s\S]*?title: "([^"]+)"/
      )
      expect(m, file).not.toBeNull()
      return m![1]
    })
    expect(new Set(titles).size).toBe(5)
    expect(titles).toEqual(
      expect.arrayContaining([
        "Sign in",
        "Sign up",
        "Forgot password",
        "Reset password",
        "Verify email",
      ])
    )
  })

  it("the dashboard layout defines the title template", () => {
    expect(read("apps/dashboard/app/layout.tsx")).toContain(
      'template: "%s — SendCMS Dashboard"'
    )
  })
})

// ---------------------------------------------------------------------------
// Admin landing split (PRF-006)
// ---------------------------------------------------------------------------

describe("admin landing split (PRF-006)", () => {
  it("the shell renders without the session lookup; only the CTA waits", () => {
    const text = read("apps/admin/app/page.tsx")
    expect(text).toContain("<Suspense")
    expect(text).toContain("async function LandingActions()")
    // The page shell itself never awaits the session.
    const shell = text.split("async function LandingActions()")[0]
    expect(shell).not.toContain("await auth()")
    expect(text).toContain("await auth()")
  })
})

// ---------------------------------------------------------------------------
// Dead marketing CSS import (UX-208)
// ---------------------------------------------------------------------------

describe("dead marketing CSS import (UX-208)", () => {
  const MARKETING_CLASSES = [
    "section",
    "section-sm",
    "section-light",
    "section-container",
    "container",
  ]

  it("dashboard/admin globals do not import the marketing section stylesheet", () => {
    for (const app of ["dashboard", "admin"]) {
      const text = read(`apps/${app}/app/globals.css`)
      expect(text, `${app}/globals.css`).not.toContain("components.css")
    }
    // The marketing app keeps its import (its file stays in place).
    expect(read("apps/marketing/app/globals.css")).toContain("components.css")
  })

  it("no dashboard/admin page uses the marketing section classes", () => {
    const files = [
      ...filesUnder("apps/dashboard/app"),
      ...filesUnder("apps/dashboard/components"),
      ...filesUnder("apps/admin/app"),
      ...filesUnder("apps/admin/components"),
    ]
    const users: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      for (const cls of MARKETING_CLASSES) {
        // className="... <cls> ..." (word-boundary match, no cn() false
        // positives: the classes never appear as bare words here).
        if (new RegExp(`className="[^"]*\\b${cls}\\b`).test(text)) {
          users.push(`${file}: .${cls}`)
        }
      }
    }
    expect(users).toEqual([])
  })
})
