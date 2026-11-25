// Phase 16, Wave 2 — Stream B regression pins.
//
// Most of these are source-level pins (read the file, assert the
// guard is there): the proxy and page guards cannot be exercised
// from vitest without a Next.js runtime, so the test pins the exact
// code the live probes verify against the dev servers. The live
// probes are in the Stream B working paper.
import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PLATFORM_ROUTE_CAPABILITY, adminCan } from "@sendcms/permissions"
import { ApiError, handleApiError } from "@sendcms/api-client"
import { resolveSignInCallbackURL } from "../apps/dashboard/lib/callback-url"

const repoRoot = path.resolve(import.meta.dirname, "..")

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8")
}

// ─── SRC-105: every admin API handler is route-gated ──────────────────────

// "METHOD path" → the capability requireAdminApi must assert before
// the service runs. This is the whole 80-route / 92-handler map,
// derived from the wired routes (see the Stream B working paper).
const ADMIN_ROUTE_CAPABILITIES: Record<string, string> = {
  "PATCH ai/providers/[provider]": "MANAGE_AI",
  "GET ai/providers/health": "MANAGE_AI",
  "GET ai/providers": "MANAGE_AI",
  "POST ai/providers": "MANAGE_AI",
  "GET ai/usage": "VIEW_AI_USAGE",
  "GET ai/usage/summary": "VIEW_AI_USAGE",
  "POST ai/users/[userId]/billing-mode": "MANAGE_AI",
  "GET ai/users/[userId]/keys": "MANAGE_AI",
  "GET announcements/[announcementId]": "MANAGE_ANNOUNCEMENTS",
  "PATCH announcements/[announcementId]": "MANAGE_ANNOUNCEMENTS",
  "GET announcements": "MANAGE_ANNOUNCEMENTS",
  "POST announcements": "MANAGE_ANNOUNCEMENTS",
  "GET audit-logs/[id]": "VIEW_AUDIT_LOGS",
  "GET audit-logs/export": "EXPORT_AUDIT_LOGS",
  "GET audit-logs": "VIEW_AUDIT_LOGS",
  "GET billing/checkout-attempts": "VIEW_BILLING",
  "GET billing/countries": "VIEW_BILLING",
  "GET billing/events": "VIEW_BILLING",
  "PATCH billing/providers/[provider]": "MANAGE_BILLING",
  "GET billing/providers": "VIEW_BILLING",
  "POST billing/providers": "MANAGE_BILLING",
  "POST deletion-requests/[id]/erase": "MANAGE_USERS",
  "POST deletion-requests/[id]/review": "MANAGE_USERS",
  "GET deletion-requests": "MANAGE_USERS",
  "DELETE features/[key]/overrides/[userId]": "MANAGE_FEATURE_FLAGS",
  "GET features/[key]/overrides": "MANAGE_FEATURE_FLAGS",
  "POST features/[key]/overrides": "MANAGE_FEATURE_FLAGS",
  "GET features/[key]": "MANAGE_FEATURE_FLAGS",
  "PATCH features/[key]": "MANAGE_FEATURE_FLAGS",
  "GET features": "MANAGE_FEATURE_FLAGS",
  "POST features": "MANAGE_FEATURE_FLAGS",
  "GET health": "VIEW_ADMIN_DASHBOARD",
  "POST mcp/keys/[keyId]/revoke": "MANAGE_MCP",
  "GET mcp/keys": "VIEW_MCP",
  "GET mcp/settings": "VIEW_MCP",
  "POST mcp/settings": "MANAGE_MCP",
  "GET mcp/usage": "VIEW_MCP",
  "GET mcp/usage/summary": "VIEW_MCP",
  "GET mcp/users/[userId]/settings": "VIEW_MCP",
  "POST mcp/users/[userId]/settings": "MANAGE_MCP",
  "GET overview": "VIEW_ADMIN_DASHBOARD",
  "POST plans/[planId]/archive": "MANAGE_PLANS",
  "POST plans/[planId]/duplicate": "MANAGE_PLANS",
  "GET plans/[planId]": "VIEW_PLAN_VERSIONS",
  "POST plans/[planId]/versions/[versionId]/publish": "PUBLISH_PLAN_VERSIONS",
  "GET plans/[planId]/versions/[versionId]": "VIEW_PLAN_VERSIONS",
  "POST plans/[planId]/versions": "MANAGE_PLANS",
  "GET plans/compare": "VIEW_PLAN_VERSIONS",
  "GET plans": "VIEW_PLAN_VERSIONS",
  "POST plans": "MANAGE_PLANS",
  "POST step-up/verify": "VIEW_ADMIN_DASHBOARD",
  "GET submissions/[submissionId]": "VIEW_SENSITIVE_SUBMISSIONS",
  "POST submissions/[submissionId]/status": "MANAGE_USERS",
  "GET submissions": "VIEW_CUSTOMER_DATA",
  "GET submissions/stats": "VIEW_CUSTOMER_DATA",
  "POST subscriptions/[subscriptionId]/cancel": "MANAGE_SUBSCRIPTIONS",
  "GET subscriptions/[subscriptionId]": "VIEW_CUSTOMER_DATA",
  "POST subscriptions/assign": "MANAGE_SUBSCRIPTIONS",
  "POST subscriptions/migrate/preview": "MIGRATE_SUBSCRIPTIONS",
  "POST subscriptions/migrate": "MIGRATE_SUBSCRIPTIONS",
  "GET subscriptions": "VIEW_USERS",
  "GET support/staff": "VIEW_CUSTOMER_DATA",
  "POST support/tickets/[ticketId]/assign": "VIEW_CUSTOMER_DATA",
  "POST support/tickets/[ticketId]/reply": "VIEW_CUSTOMER_DATA",
  "GET support/tickets/[ticketId]": "VIEW_CUSTOMER_DATA",
  "POST support/tickets/[ticketId]/status": "VIEW_CUSTOMER_DATA",
  "GET support/tickets": "VIEW_CUSTOMER_DATA",
  "GET system": "VIEW_ADMIN_DASHBOARD",
  "GET translations/[locale]/export": "MANAGE_TRANSLATIONS",
  "GET translations": "MANAGE_TRANSLATIONS",
  "GET usage": "MANAGE_USAGE",
  "POST users/[userId]/deletion-request": "MANAGE_USERS",
  "POST users/[userId]/disable": "MANAGE_USERS",
  "GET users/[userId]/export": "VIEW_CUSTOMER_DATA",
  "GET users/[userId]/notes": "VIEW_USERS",
  "POST users/[userId]/notes": "MANAGE_USERS",
  "DELETE users/[userId]/overrides/[meter]": "MANAGE_USAGE",
  "GET users/[userId]/overrides": "MANAGE_USAGE",
  "POST users/[userId]/overrides": "MANAGE_USAGE",
  "POST users/[userId]/password-reset": "MANAGE_USERS",
  "POST users/[userId]/reactivate": "MANAGE_USERS",
  "POST users/[userId]/require-verification": "MANAGE_USERS",
  "POST users/[userId]/restore": "MANAGE_USERS",
  "POST users/[userId]/revoke-keys": "MANAGE_USERS",
  "POST users/[userId]/revoke-sessions": "MANAGE_USERS",
  "POST users/[userId]/role": "MANAGE_USERS",
  "GET users/[userId]": "VIEW_CUSTOMER_DATA",
  "GET users/[userId]/submissions/[submissionId]": "VIEW_SENSITIVE_SUBMISSIONS",
  "GET users/[userId]/submissions": "VIEW_CUSTOMER_DATA",
  "GET users/[userId]/subscription": "VIEW_CUSTOMER_DATA",
  "POST users/[userId]/suspend": "MANAGE_USERS",
  "GET users": "VIEW_USERS",
}

describe("SRC-105 admin route capabilities", () => {
  it("pins all 92 handlers across the 80 admin routes", () => {
    expect(Object.keys(ADMIN_ROUTE_CAPABILITIES)).toHaveLength(92)
    const files = new Set(
      Object.keys(ADMIN_ROUTE_CAPABILITIES).map((k) =>
        k.slice(k.indexOf(" ") + 1)
      )
    )
    expect(files.size).toBe(80)
    for (const [key, cap] of Object.entries(ADMIN_ROUTE_CAPABILITIES)) {
      const [method, route] = [
        key.slice(0, key.indexOf(" ")),
        key.slice(key.indexOf(" ") + 1),
      ]
      const src = read(`apps/api/app/api/v1/admin/${route}/route.ts`)
      const handlers = [
        // The `\(` anchor matters: without it a mistyped `GETGET`
        // declaration still matches and the test passes while the
        // route 405s at runtime (caught live 2026-11-24).
        ...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(/g),
      ].map((m) => m[1])
      const gates = [...src.matchAll(/requireAdminApi\("([A-Z_]+)"\)/g)].map(
        (m) => m[1]
      )
      expect(handlers, `${route}: handler count`).toHaveLength(gates.length)
      const idx = handlers.indexOf(method)
      expect(idx, `${route}: ${method} handler exists`).toBeGreaterThanOrEqual(
        0
      )
      expect(gates[idx], `${method} ${route}`).toBe(cap)
      // The old bare-auth block is gone: no handler can pass a
      // non-admin session through to the service.
      expect(src).not.toContain("await auth()")
      expect(src).not.toContain('new ApiError("Unauthorized"')
    }
  })

  it("covers every admin route file on disk (no unmapped route)", () => {
    const onDisk: string[] = []
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory())
          walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        else if (entry.name === "route.ts") onDisk.push(prefix.slice(0, -1))
      }
    }
    walk(path.join(repoRoot, "apps/api/app/api/v1/admin"), "")
    const mapped = new Set(
      Object.keys(ADMIN_ROUTE_CAPABILITIES).map((k) =>
        k.slice(k.indexOf(" ") + 1)
      )
    )
    expect(new Set(onDisk)).toEqual(mapped)
  })
})

// ─── SEC-102: per-role × admin page ────────────────────────────────────────

describe("SEC-102 admin page access by role", () => {
  // The proxy redirects to /admin/unauthorized when adminCan(role,
  // PLATFORM_ROUTE_CAPABILITY[path]) is false. These are the exact
  // page families each staff role may load.
  const supportAllowed = [
    "/admin",
    "/admin/health",
    "/admin/mcp",
    "/admin/mcp/keys",
    "/admin/settings",
    "/admin/submissions",
    "/admin/subscriptions",
    "/admin/support",
    "/admin/users",
  ]
  const managerDenied = [
    "/admin/ai/providers",
    "/admin/ai/settings",
    "/admin/announcements",
    "/admin/features",
    "/admin/subscriptions/migrate",
    "/admin/translations",
  ]

  it("SUPPORT loads exactly the support page families (not /admin/plans)", () => {
    for (const [route, cap] of Object.entries(PLATFORM_ROUTE_CAPABILITY)) {
      expect(adminCan("SUPPORT", cap), `SUPPORT ${route} (${cap})`).toBe(
        supportAllowed.includes(route)
      )
    }
  })

  it("MANAGER loads everything except the six denied families", () => {
    for (const [route, cap] of Object.entries(PLATFORM_ROUTE_CAPABILITY)) {
      expect(adminCan("MANAGER", cap), `MANAGER ${route} (${cap})`).toBe(
        !managerDenied.includes(route)
      )
    }
  })

  it("a plain platform user loads no admin page", () => {
    for (const [route, cap] of Object.entries(PLATFORM_ROUTE_CAPABILITY)) {
      expect(adminCan("PLATFORM_USER", cap), route).toBe(false)
    }
  })

  // The support ticket routes admit SUPPORT or MANAGE_USERS holders
  // (requireTicketWrite) — that set is exactly the
  // VIEW_CUSTOMER_DATA holders, which is why the route map gates
  // the ticket handlers on VIEW_CUSTOMER_DATA.
  it("ticket-write admission equals VIEW_CUSTOMER_DATA admission", () => {
    for (const role of [
      "PLATFORM_OWNER",
      "PLATFORM_USER",
      "SUPER_ADMIN",
      "MANAGER",
      "SUPPORT",
    ] as const) {
      expect(role === "SUPPORT" || adminCan(role, "MANAGE_USERS"), role).toBe(
        adminCan(role, "VIEW_CUSTOMER_DATA")
      )
    }
  })

  // The two route-map equivalences the SRC-105 map relies on: a
  // page/route gated on the broader capability admits exactly the
  // holders of the narrower one, so no second layer is bypassed.
  it("VIEW_USERS holders all hold VIEW_CUSTOMER_DATA (user detail second layer)", () => {
    for (const role of [
      "PLATFORM_OWNER",
      "PLATFORM_USER",
      "SUPER_ADMIN",
      "MANAGER",
      "SUPPORT",
    ] as const) {
      if (adminCan(role, "VIEW_USERS")) {
        expect(adminCan(role, "VIEW_CUSTOMER_DATA"), role).toBe(true)
      }
    }
  })

  it("MANAGE_AI holders all hold VIEW_CUSTOMER_DATA (AI user-keys second layer)", () => {
    for (const role of [
      "PLATFORM_OWNER",
      "PLATFORM_USER",
      "SUPER_ADMIN",
      "MANAGER",
      "SUPPORT",
    ] as const) {
      if (adminCan(role, "MANAGE_AI")) {
        expect(adminCan(role, "VIEW_CUSTOMER_DATA"), role).toBe(true)
      }
    }
  })
})

// ─── ADM-001: Better Auth APIErrors keep their status ──────────────────────

describe("ADM-001 handleApiError maps Better Auth APIErrors", () => {
  function fakeAuthError() {
    const err = new Error("EMAIL_MISMATCH") as Error & {
      name: string
      statusCode: number
      body: { message: string; code: string }
    }
    err.name = "APIError"
    err.statusCode = 400
    err.body = { message: "EMAIL_MISMATCH", code: "EMAIL_MISMATCH" }
    return err
  }

  it("returns the real status/message instead of a generic 500", async () => {
    const res = handleApiError(fakeAuthError())
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "EMAIL_MISMATCH" })
  })

  it("still maps ApiError by its own status", async () => {
    const res = handleApiError(new ApiError("Forbidden", 403))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("still collapses a plain error to a generic 500", async () => {
    const res = handleApiError(new Error("boom"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Internal server error" })
  })
})

// ─── SRC-102 / SEC-011: dashboard pages never dereference session! ────────

describe("SRC-102 dashboard pages require a session", () => {
  const pages = [
    // Route groups (DSH-104/204/409, Wave 4): the list/overview pages
    // live in (overview)/(list) groups so their loading.tsx skeletons
    // do not wrap the detail segments.
    "apps/dashboard/app/dashboard/(overview)/page.tsx",
    "apps/dashboard/app/dashboard/inbox/(list)/page.tsx",
    "apps/dashboard/app/dashboard/inbox/[submissionId]/page.tsx",
    "apps/dashboard/app/dashboard/domains/(list)/page.tsx",
    "apps/dashboard/app/dashboard/domains/[domainId]/page.tsx",
    "apps/dashboard/app/dashboard/forms/(list)/page.tsx",
    "apps/dashboard/app/dashboard/forms/[formId]/page.tsx",
    "apps/dashboard/app/dashboard/forms/new/page.tsx",
    "apps/dashboard/app/dashboard/account/page.tsx",
    "apps/dashboard/app/dashboard/notifications/page.tsx",
    "apps/dashboard/app/dashboard/analytics/page.tsx",
    "apps/dashboard/app/dashboard/api/page.tsx",
    "apps/dashboard/app/dashboard/api-keys/page.tsx",
  ]

  it("all 13 pages go through requireDashboardSession, never session!", () => {
    expect(pages).toHaveLength(13)
    for (const page of pages) {
      const src = read(page)
      expect(src, `${page}: uses the helper`).toContain(
        "requireDashboardSession"
      )
      expect(
        src,
        `${page}: no non-null assertion on the session`
      ).not.toContain("session!")
    }
  })
})

// ─── SRC-116: the callback URL survives sign-in ────────────────────────────

describe("SRC-116 callback URL", () => {
  it("the dashboard proxy appends callbackURL on unauthenticated redirect", () => {
    const proxy = read("apps/dashboard/proxy.ts")
    expect(proxy).toContain("callbackURL")
    expect(proxy).toContain("redirectToSignIn")
  })

  it("the sign-in page passes the validated callback to both forms", () => {
    const page = read("apps/dashboard/app/(auth)/sign-in/page.tsx")
    expect(page).toContain("resolveSignInCallbackURL")
    expect(page).toContain("callbackURL={callback}")
    const form = read(
      "apps/dashboard/app/(auth)/sign-in/email-sign-in-form.tsx"
    )
    expect(form).toContain("callbackURL,")
    expect(form).toContain("router.push(callbackURL)")
  })

  it("accepts a relative dashboard deep link", () => {
    expect(resolveSignInCallbackURL("/dashboard/inbox/abc-123")).toBe(
      "http://localhost:3002/dashboard/inbox/abc-123"
    )
  })

  it("accepts an absolute admin URL", () => {
    expect(resolveSignInCallbackURL("http://localhost:3006/admin/users")).toBe(
      "http://localhost:3006/admin/users"
    )
  })

  it("rejects a foreign host, a protocol-relative URL, and backslashes", () => {
    const fallback = "http://localhost:3002/dashboard"
    expect(resolveSignInCallbackURL("https://evil.example.com/x")).toBe(
      fallback
    )
    expect(resolveSignInCallbackURL("//evil.example.com/x")).toBe(fallback)
    expect(resolveSignInCallbackURL("/dashboard\\inbox")).toBe(fallback)
    expect(resolveSignInCallbackURL(undefined)).toBe(fallback)
  })
})

// ─── SEC-006: the dashboard proxy redirects instead of 500ing ──────────────

describe("SEC-006 dashboard proxy session failure", () => {
  it("wraps the session lookup in try/catch and redirects to sign-in", () => {
    const proxy = read("apps/dashboard/proxy.ts")
    expect(proxy).toMatch(/try\s*\{[\s\S]*?getSession/)
    expect(proxy).toContain("dashboard proxy session lookup failed")
    expect(proxy).toContain("redirectToSignIn()")
  })
})

// ─── SEC-107: the admin error boundary leaks nothing ───────────────────────

describe("SEC-107 admin error boundary", () => {
  it("renders a generic message with no error text, stack, or paths", () => {
    const boundary = read("apps/admin/app/error.tsx")
    // Wave 7 (I18N-310): the generic message is translated, not
    // hardcoded English — the rendered English text is unchanged.
    expect(boundary).toContain('t("errorTitle")')
    expect(boundary).toContain('t("errorDescription")')
    expect(boundary).toContain('t("errorTryAgain")')
    expect(boundary).toContain('t("errorGoToDashboard")')
    expect(boundary).not.toContain("Something went wrong")
    expect(boundary).not.toContain("This admin page could not be loaded")
    expect(boundary).toContain('href="/admin"')
    const navEn = JSON.parse(
      read("packages/i18n/locales/en/admin/navigation.json")
    )
    expect(navEn.errorTitle).toBe("Something went wrong")
    expect(navEn.errorDescription).toBe(
      "This admin page could not be loaded. Try again, or go back to the admin dashboard."
    )
    // The component never renders the error: no message, no stack,
    // no interpolation of the error object at all. (The word "stack"
    // appears in the header comment that states this rule.)
    expect(boundary).not.toContain("error.message")
    expect(boundary).not.toContain("error.stack")
    expect(boundary).not.toContain("{error")
  })
})

// ─── SEC-104: the five in-scope actions are step-up gated ──────────────────

describe("SEC-104 step-up gates stay on the five in-scope actions", () => {
  it("disableUser, setAdminRole, revokeMcpKey, setMcpSettings, reviewDeletionRequest, executeErasure call requireStepUp", () => {
    const adminUsers = read("packages/modules/admin-users/src/service.ts")
    expect(adminUsers).toMatch(
      /export async function disableUser[\s\S]*?requireStepUp\(/
    )
    expect(adminUsers).toMatch(
      /export async function setAdminRole[\s\S]*?requireStepUp\(/
    )
    // revokeUserApiKeys is gated too (SEC-103 / ADM-009) — the
    // authorization doc used to lump it with revokeUserSessions,
    // which is NOT gated. The split row pins both (the negative
    // check is bounded to the revokeUserSessions body).
    expect(adminUsers).toMatch(
      /export async function revokeUserApiKeys[\s\S]*?requireStepUp\(/
    )
    const revokeSessionsBody = adminUsers.match(
      /export async function revokeUserSessions\([\s\S]*?^}/m
    )?.[0]
    expect(revokeSessionsBody).toBeDefined()
    expect(revokeSessionsBody).not.toContain("requireStepUp")
    const mcp = read("packages/modules/mcp-admin/src/service.ts")
    expect(mcp).toMatch(
      /export async function setMcpSettings[\s\S]*?requireStepUp\(/
    )
    expect(mcp).toMatch(
      /export async function revokeMcpKey[\s\S]*?requireStepUp\(/
    )
    const ops = read("packages/modules/platform-ops/src/deletion.ts")
    expect(ops).toMatch(/reviewDeletionRequest[\s\S]*?requireStepUp\(/)
    expect(ops).toMatch(
      /export async function executeErasure[\s\S]*?requireStepUp\(/
    )
  })

  it("the authorization doc lists the out-of-scope actions as intentionally out", () => {
    const doc = read("docs/admin-control-plane/authorization.md")
    for (const action of [
      "executeMigration",
      "publishPlanVersion",
      "assignSubscription",
      "setProviderConfig",
    ]) {
      expect(doc).toContain(action)
    }
    expect(doc).toContain("confirmed\nunchanged on 2026-11-24")
  })
})

// ─── SRC-411: drift test for the copies that stay copied ───────────────────

describe("SRC-411 drift test for intentional copies", () => {
  function functionBody(src: string, name: string): string {
    const match = src.match(
      new RegExp(`export function ${name}\\(\\): string \\{[\\s\\S]*?\\n\\}`)
    )
    expect(match, `${name} exists`).not.toBeNull()
    return match![0]
  }

  it("marketingUrl() is identical in the three app-links files that define it", () => {
    const files = [
      "apps/dashboard/lib/app-links.ts",
      "apps/docs/lib/app-links.ts",
      "apps/updates/lib/app-links.ts",
    ]
    const bodies = files.map((f) => functionBody(read(f), "marketingUrl"))
    expect(bodies[1]).toBe(bodies[0])
    expect(bodies[2]).toBe(bodies[0])
  })

  it("apiUrl() is a single copy (marketing only)", () => {
    const holders = [
      "apps/dashboard/lib/app-links.ts",
      "apps/docs/lib/app-links.ts",
      "apps/marketing/lib/app-links.ts",
      "apps/updates/lib/app-links.ts",
    ].filter((f) => read(f).includes("export function apiUrl"))
    expect(holders).toEqual(["apps/marketing/lib/app-links.ts"])
  })

  it("the shared stylesheets are byte-identical across the 5 apps", () => {
    const apps = ["dashboard", "marketing", "updates", "docs", "admin"]
    const files = [
      "app/globals.css",
      "styles/design-tokens.css",
      "styles/components.css",
    ]
    for (const file of files) {
      const base = read(`apps/dashboard/${file}`)
      for (const app of apps.slice(1)) {
        expect(read(`apps/${app}/${file}`), `${app}/${file}`).toBe(base)
      }
    }
  })

  it("open-next.config.ts is byte-identical across the 6 apps", () => {
    const apps = ["api", "dashboard", "marketing", "updates", "docs", "admin"]
    const base = read("apps/api/open-next.config.ts")
    for (const app of apps.slice(1)) {
      expect(read(`apps/${app}/open-next.config.ts`), app).toBe(base)
    }
  })

  it("the app config copies match except the admin's three branding fields", () => {
    const apps = ["dashboard", "marketing", "updates", "docs"]
    const base = JSON.parse(
      read("apps/dashboard/config/config.json")
    ) as Record<string, unknown>
    for (const app of apps.slice(1)) {
      expect(JSON.parse(read(`apps/${app}/config/config.json`)), app).toEqual(
        base
      )
    }
    const admin = JSON.parse(read("apps/admin/config/config.json")) as {
      metadata: Record<string, unknown>
      site: Record<string, unknown>
    }
    delete admin.metadata.meta_description
    delete admin.site.logo_text
    delete admin.site.title
    const baseCopy = JSON.parse(JSON.stringify(base)) as {
      metadata: Record<string, unknown>
      site: Record<string, unknown>
    }
    delete baseCopy.metadata.meta_description
    delete baseCopy.site.logo_text
    delete baseCopy.site.title
    expect(admin).toEqual(baseCopy)
  })

  it("the root config is the platform config, not an app copy", () => {
    const root = JSON.parse(read("config/config.json")) as Record<
      string,
      unknown
    >
    expect(Object.keys(root).sort()).toEqual([
      "platform",
      "rateLimits",
      "stepUp",
    ])
    const app = JSON.parse(read("apps/dashboard/config/config.json")) as Record<
      string,
      unknown
    >
    expect(Object.keys(app).sort()).toEqual([
      "branding",
      "email",
      "metadata",
      "site",
    ])
  })
})

// ─── SEC-102: the admin proxy uses longest-prefix matching ─────────────────

describe("SEC-102 admin proxy", () => {
  it("matches the longest route prefix and keeps the unauthorized exemption", () => {
    const proxy = read("apps/admin/proxy.ts")
    expect(proxy).toContain("/admin/unauthorized")
    expect(proxy).toMatch(/sort\(\(a, b\) => b\.length - a\.length\)/)
    expect(proxy).toContain("PLATFORM_ROUTE_CAPABILITY")
    expect(existsSync(path.join(repoRoot, "apps/admin/app/error.tsx"))).toBe(
      true
    )
  })
})
