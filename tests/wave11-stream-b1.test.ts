// Phase 16, Wave 11 — Stream B1 (Caching / performance).
//
// PRF-001, PRF-002, PRF-003, PRF-004, PRF-005, PRF-007, PRF-008.
// PRF-010 has no code change (could-not-reproduce — see the stream
// working paper); it is covered by the live probe evidence, not a test.
//
// Most assertions here are config/source checks: the header rules
// live in `next.config.mjs` `headers()`, which only takes effect in a
// running server, so the tests pin the config text and the live
// probes (production build on :3110/:3111) verify the served headers.
import { describe, expect, it } from "vitest"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEFAULT_BUDGETS_KB,
  measureFirstLoad,
} from "../scripts/check-bundle-budget.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..")
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8")

const PUBLIC_CACHE =
  "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400"

describe("PRF-003 — SDK bundle cache headers (api)", () => {
  const config = read("apps/api/next.config.mjs")

  it("sets the edge-cache rule for /forms/*", () => {
    expect(config).toContain('"/forms/:path*"')
    expect(config).toContain(PUBLIC_CACHE)
  })

  it("does NOT use immutable — the SDK filename is unversioned", () => {
    // The /forms rule must not claim immutability: v1.js is
    // overwritten on each deploy.
    const formsRule = config.slice(config.indexOf('"/forms/:path*"'))
    const block = formsRule.slice(0, formsRule.indexOf("},"))
    expect(block).not.toContain("immutable")
  })

  it("keeps API responses no-store (PRF-009 still holds)", () => {
    expect(config).toContain('"/api/:path*"')
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }')
  })
})

describe("PRF-004 — static image / favicon cache headers", () => {
  for (const app of [
    "marketing",
    "api",
    "dashboard",
    "docs",
    "updates",
    "admin",
  ]) {
    it(`${app}: /images/* and /favicon.ico get the day-long edge rule`, () => {
      const config = read(`apps/${app}/next.config.mjs`)
      expect(config).toContain('"/images/:path*"')
      expect(config).toContain('"/favicon.ico"')
      expect(config).toContain(PUBLIC_CACHE)
    })

    it(`${app}: relies on the optimizer's own caching for /_next/image`, () => {
      const config = read(`apps/${app}/next.config.mjs`)
      expect(config).not.toContain('"/_next/image')
    })
  }
})

describe("PRF-005 — proxy-level 405 on the submit endpoint", () => {
  const proxy = read("apps/api/proxy.ts")
  const route = read("apps/api/app/api/public/v1/submit/route.ts")

  it("rejects non-POST/non-OPTIONS submit requests in the proxy", () => {
    expect(proxy).toContain('"/api/public/v1/submit"')
    expect(proxy).toContain('req.method !== "POST"')
    expect(proxy).toContain('req.method !== "OPTIONS"')
    expect(proxy).toContain("status: 405")
    expect(proxy).toContain('Allow: "POST, OPTIONS"')
  })

  it("keeps the route-level 405s as a backstop (SDK-031)", () => {
    expect(route).toContain('methodNotAllowed(["POST", "OPTIONS"])')
  })
})

describe("PRF-002 — cheap liveness + deep health", () => {
  const liveness = read("apps/api/app/api/health/route.ts")
  const deep = read("apps/api/app/api/health/deep/route.ts")

  it("liveness touches no database and no service", () => {
    // Matched on import/call sites, not on words: the file's own
    // comment names the deep route and its contents.
    expect(liveness).not.toContain('from "@sendcms/database"')
    expect(liveness).not.toContain("pingDatabase(")
    expect(liveness).not.toContain('from "@sendcms/cron"')
    expect(liveness).not.toContain("getLastCronRun(")
    expect(liveness).toContain('status: "ok"')
  })

  it("deep keeps the DB ping + last cron run (the old /api/health body)", () => {
    expect(deep).toContain("pingDatabase")
    expect(deep).toContain("getLastCronRun")
  })

  it("orchestrator healthchecks point at the deep endpoint", () => {
    const compose = read("docker-compose.yml")
    expect(compose).toContain("http://localhost:3001/api/health/deep")
    expect(compose).not.toContain('http://localhost:3001/api/health"')
    expect(read("render.yaml")).toContain("healthCheckPath: /api/health/deep")
  })
})

describe("PRF-001 — CSP nonce is NOT removed; session routes stay no-store", () => {
  // The experiment (see the stream working paper) proved that
  // removing `await headers()` from a public layout makes the page
  // static but strips the nonce from every inline script — the theme
  // script and the RSC flight scripts would then be blocked by the
  // enforcing CSP, breaking hydration. Until the CSP is served from
  // a per-page hash manifest (the documented follow-up), the nonce
  // threading stays, pages stay dynamic, and NO public page-cache
  // rule may be added (caching nonce'd HTML would reuse nonces
  // across users). These tests pin that invariant.
  for (const app of ["marketing", "docs", "updates", "dashboard", "admin"]) {
    it(`${app}: layout still threads the proxy nonce to ThemeProvider`, () => {
      const layout = read(`apps/${app}/app/layout.tsx`)
      expect(layout).toContain("await headers()")
      expect(layout).toContain("ThemeProvider nonce={nonce}")
    })
  }

  for (const app of ["marketing", "docs", "updates"]) {
    it(`${app}: no page-level public cache rule (nonce'd HTML is not cacheable)`, () => {
      const config = read(`apps/${app}/next.config.mjs`)
      expect(config).not.toContain("s-maxage=3600")
    })
  }

  it("dashboard: session routes are explicitly no-store", () => {
    const config = read("apps/dashboard/next.config.mjs")
    for (const source of [
      '"/"',
      '"/dashboard/:path*"',
      '"/sign-in"',
      '"/sign-up"',
      '"/forgot-password"',
      '"/reset-password"',
      '"/verify-email"',
    ]) {
      expect(config).toContain(source)
    }
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }')
  })

  it("admin: session routes are explicitly no-store", () => {
    const config = read("apps/admin/next.config.mjs")
    expect(config).toContain('"/admin/:path*"')
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }')
  })
})

describe("PRF-008 — logo sizing + single preload", () => {
  const logo = read("packages/ui/src/components/logo.tsx")

  it("sizes the image to its 160px display slot (160w 1x / 320w 2x)", () => {
    // The display size drives the srcset (see logo.tsx: no `sizes`
    // prop — Next enumerates every width when one is given).
    expect(logo).toContain("const DISPLAY_WIDTH = 160")
    expect(logo).toContain("Math.min(width, DISPLAY_WIDTH)")
    expect(logo).not.toContain("sizes=")
  })

  it("preloads exactly one theme variant (light by default, dark when pinned)", () => {
    expect(logo).toContain('const lightPriority = variant !== "dark"')
    expect(logo).toContain('const darkPriority = variant === "dark"')
    expect(logo).toContain("priority={lightPriority}")
    expect(logo).toContain("priority={darkPriority}")
    // No bare `priority` prop anywhere — both variants used to carry one.
    expect(logo).not.toMatch(/^\s*priority\s*$/m)
  })

  for (const app of [
    "marketing",
    "api",
    "dashboard",
    "docs",
    "updates",
    "admin",
  ]) {
    it(`${app}: imageSizes [160, 320]`, () => {
      expect(read(`apps/${app}/next.config.mjs`)).toContain(
        "imageSizes: [160, 320]"
      )
    })
  }
})

describe("PRF-007 — first-load budget + dead Toaster removal", () => {
  it("budgets are 250 kB brotli (marketing /) and 300 kB (dashboard /sign-in)", () => {
    expect(DEFAULT_BUDGETS_KB["apps/marketing:/"]).toBe(250)
    expect(DEFAULT_BUDGETS_KB["apps/dashboard:/sign-in"]).toBe(300)
  })

  it("measures first-load JS from page HTML, excluding noModule polyfills from the modern total", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "b1-budget-"))
    try {
      // Fake chunks: the "framework" chunk is the big one, the
      // polyfill is noModule and must not count toward modern.
      writeFileSync(path.join(dir, "framework.js"), "x".repeat(200_000))
      writeFileSync(path.join(dir, "page.js"), "y".repeat(10_000))
      writeFileSync(path.join(dir, "polyfill.js"), "z".repeat(100_000))
      const html = [
        '<script src="/_next/static/chunks/framework.js" async=""></script>',
        '<script src="/_next/static/chunks/page.js" async=""></script>',
        '<script src="/_next/static/chunks/polyfill.js" noModule=""></script>',
      ].join("\n")
      const result = measureFirstLoad(html, dir)
      expect(result.scripts).toHaveLength(3)
      expect(result.totalRaw).toBe(310_000)
      expect(result.totalRawModern).toBe(210_000)
      expect(result.totalBrotliModern).toBeGreaterThan(0)
      expect(result.totalBrotliModern).toBeLessThan(result.totalBrotli)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("public layouts render no Toaster (no toast() call site exists there)", () => {
    for (const app of ["marketing", "docs", "updates"]) {
      const layout = read(`apps/${app}/app/layout.tsx`)
      // No import and no JSX usage (the rationale comment may still
      // name the component).
      expect(layout).not.toContain("import { Toaster }")
      expect(layout).not.toContain("<Toaster")
    }
  })

  it("dashboard: the toast container lives in the dashboard group layout, NOT the root layout", () => {
    // PRF-007 (Wave 11, replacement B1): the root layout rendered
    // <Toaster>, which pulled sonner into the shared chunk every page
    // loads — including /sign-in, which never calls toast(). Every
    // toast() call site lives under app/dashboard/ or
    // components/dashboard/, so the container moved to the dashboard
    // group layout; auth pages then skip the sonner bundle entirely.
    // (Measured effect is recorded in the PRF-007 working paper.)
    const root = read("apps/dashboard/app/layout.tsx")
    expect(root).not.toContain("<Toaster")
    expect(root).not.toContain("Toaster }")
    const group = read("apps/dashboard/app/dashboard/layout.tsx")
    expect(group).toContain("Toaster,")
    expect(group).toContain("<Toaster")
    expect(group).toContain('containerAriaLabel={t("notifications")}')
  })

  it("@sendcms/ui is side-effect-free so the barrel tree-shakes", () => {
    // PRF-007 (Wave 11, replacement B1): without
    // `"sideEffects": false`, importing anything from @sendcms/ui
    // pulled every re-exported component (sonner, recharts, radix-ui)
    // into every page's first-load JS — dashboard /sign-in measured
    // 303.5 kB brotli against a 300 kB budget. With it: 237.4 kB.
    // There are no CSS imports or top-level side effects anywhere in
    // packages/ui/src; if a side-effectful module is ever added, this
    // flag must be revisited (and the bundle budget re-measured).
    const pkg = JSON.parse(read("packages/ui/package.json")) as {
      sideEffects?: unknown
    }
    expect(pkg.sideEffects).toBe(false)
  })

  it("dashboard: no auth page imports sonner or calls toast()", () => {
    // The guard for the move above: if an auth page ever starts
    // toasting, the container must move back to the root layout.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry)
        return statSync(full).isDirectory() ? walk(full) : [full]
      })
    const authDir = path.join(repoRoot, "apps/dashboard/app/(auth)")
    for (const file of walk(authDir)) {
      const src = readFileSync(file, "utf8")
      expect(src).not.toContain('from "sonner"')
      expect(src).not.toContain("toast(")
    }
  })

  it("admin layout keeps its Toaster (toast() is used there)", () => {
    expect(read("apps/admin/app/layout.tsx")).toContain("Toaster")
  })
})
