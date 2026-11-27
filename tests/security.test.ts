/**
 * Phase 10 — security package tests: the shared headers definition
 * (and the committed `_headers` files matching it) + the shared audit
 * writer.
 */
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_HEADER_NAME,
  CSP_REPORT_ONLY,
  CSP_REPORT_ONLY_HEADER_NAME,
  isValidBearerToken,
  renderHeadersFile,
  securityHeaders,
} from "@sendcms/security"

// `vi.mock` factories are hoisted above the file's top-level code, so
// the mocks they close over must be created with `vi.hoisted` (the
// codebase's established pattern for this).
const { mockCreate, mockLoggerError } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockLoggerError: vi.fn(),
}))

// The audit writer logs its own failures through the observability
// logger — stub it so a failing write stays quiet in the test output
// and the call is assertable.
vi.mock("@sendcms/observability", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}))

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return {
    ...actual,
    db: { ...actual.db, auditLog: { create: mockCreate } },
  }
})

import { AuditAction, AuditResource } from "@sendcms/database"
import { logAudit } from "@sendcms/security"

describe("securityHeaders", () => {
  it("covers every route with the five security headers", () => {
    const entries = securityHeaders()
    const all = entries.find((e) => e.source === "/:path*")
    expect(all).toBeDefined()
    const byKey = Object.fromEntries(all!.headers.map((h) => [h.key, h.value]))
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff")
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
    expect(byKey["X-Frame-Options"]).toBe("SAMEORIGIN")
    expect(byKey["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()"
    )
    // HSTS (Phase 16, SRC-301): no `preload` — preloading commits
    // every subdomain to HTTPS, and that was not confirmed.
    expect(byKey["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    )
  })

  it("sets an immutable cache header for Next's static chunks — in the _headers file only", () => {
    // Next.js already sets `immutable` for its static chunks in
    // production, and a custom Cache-Control in `headers()` makes Next
    // warn that it can break development behavior — so the cache header
    // lives only in the Cloudflare asset-layer file, not in the Next
    // config entries.
    const entries = securityHeaders()
    const keys = entries.flatMap((e) => e.headers.map((h) => h.key))
    expect(keys).not.toContain("Cache-Control")
    const file = renderHeadersFile()
    expect(file).toContain("/_next/static/*")
    expect(file).toContain("Cache-Control: public, max-age=31536000, immutable")
  })

  it("sets no Content-Security-Policy", () => {
    const keys = securityHeaders().flatMap((e) => e.headers.map((h) => h.key))
    expect(keys).not.toContain("Content-Security-Policy")
  })

  it("renders the committed _headers file for every app", () => {
    // The two shapes (Next `headers()` + Cloudflare `_headers`) share
    // one source — a hand-edited _headers file that drifts from it
    // fails here.
    const expected = renderHeadersFile()
    for (const app of [
      "marketing",
      "api",
      "dashboard",
      "docs",
      "updates",
      "admin",
    ]) {
      const file = readFileSync(`apps/${app}/public/_headers`, "utf8")
      expect(file, `${app}/public/_headers`).toBe(expected)
    }
  })

  it("includes HSTS in the rendered _headers file", () => {
    const file = renderHeadersFile()
    expect(file).toContain(
      "Strict-Transport-Security: max-age=31536000; includeSubDomains"
    )
    expect(file).not.toContain("preload")
  })

  it("suppresses X-Powered-By in every app config (Phase 16, SEC-302)", () => {
    for (const app of [
      "marketing",
      "api",
      "dashboard",
      "docs",
      "updates",
      "admin",
    ]) {
      const config = readFileSync(`apps/${app}/next.config.mjs`, "utf8")
      expect(config, `${app}/next.config.mjs`).toContain(
        "poweredByHeader: false"
      )
    }
  })

  it("emits X-Robots-Tag from the authenticated apps' configs (Phase 16, PRF-034)", () => {
    for (const app of ["dashboard", "admin", "api"]) {
      const config = readFileSync(`apps/${app}/next.config.mjs`, "utf8")
      expect(config, `${app}/next.config.mjs`).toContain("X-Robots-Tag")
      expect(config, `${app}/next.config.mjs`).toContain("noindex, nofollow")
    }
    // The public apps stay indexable — no X-Robots-Tag there.
    for (const app of ["marketing", "docs", "updates"]) {
      const config = readFileSync(`apps/${app}/next.config.mjs`, "utf8")
      expect(config, `${app}/next.config.mjs`).not.toContain("X-Robots-Tag")
    }
  })

  it("marks API responses no-store in the api config (Phase 16, PRF-009)", () => {
    const config = readFileSync("apps/api/next.config.mjs", "utf8")
    expect(config).toContain('"/api/:path*"')
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }')
    // PRF-003 (Wave 11) is the deliberate exception: the static SDK
    // bundle under /forms/* (not an API response) is public-cacheable
    // at the edge, so the "no public caching" assertion is scoped to
    // the /api rule block instead of the whole file. (Matched on the
    // header VALUE — the rule's own comment mentions "public".)
    const apiRule = config.slice(config.indexOf('"/api/:path*"'))
    const apiBlock = apiRule.slice(0, apiRule.indexOf('"/forms/:path*"'))
    expect(apiBlock).not.toContain('"public,')
  })
})

describe("Content-Security-Policy (Phase 9)", () => {
  it("builds the docs-shape policy with the nonce substituted", () => {
    const nonce = "test-nonce-123"
    const policy = buildCsp(nonce)
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    )
    expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`)
    expect(policy).toContain("style-src-attr 'unsafe-inline'")
    expect(policy).toContain("img-src 'self' blob: data:")
    expect(policy).toContain("font-src 'self'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'self'")
    expect(policy).toContain("form-action 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("upgrade-insecure-requests")
    // 'unsafe-inline' is allowed ONLY for style attributes: nonces do
    // not cover style="..." attributes, and the apps set inline styles
    // (shadcn sidebar CSS vars, Radix positioning). Scripts stay strict
    // and <style> elements stay nonce-gated.
    const scriptSrc =
      policy.split("; ").find((d) => d.startsWith("script-src")) ?? ""
    expect(scriptSrc).not.toContain("unsafe-inline")
    const styleSrc =
      policy.split("; ").find((d) => d.startsWith("style-src ")) ?? ""
    expect(styleSrc).not.toContain("unsafe-inline")
    expect(policy).not.toContain("connect-src")
  })

  it("adds connect-src only when an api origin is given (dashboard, admin, marketing)", () => {
    // Production origin. All three apps pass the api origin — the
    // dashboard's auth client and the admin's sign-out post
    // cross-origin to the api app, and marketing's demo REST tab
    // fetches the submit API there.
    const policy = buildCsp("n", { apiOrigin: "https://api.sendcms.bond" })
    expect(policy).toContain("connect-src 'self' https://api.sendcms.bond")
    // Dev origin (localhost:3001) — same shape, no special-casing.
    const devPolicy = buildCsp("n", { apiOrigin: "http://localhost:3001" })
    expect(devPolicy).toContain("connect-src 'self' http://localhost:3001")
  })

  it("emits report-uri when a report endpoint is given (Phase 16, SRC-318)", () => {
    const policy = buildCsp("n", {
      apiOrigin: "https://api.sendcms.bond",
      reportUri: "https://api.sendcms.bond/api/csp-report",
    })
    expect(policy).toContain(
      "report-uri https://api.sendcms.bond/api/csp-report"
    )
    // No report endpoint → no reporting directive.
    expect(buildCsp("n")).not.toContain("report-uri")
  })

  it("allow-lists extra script origins only when asked (Phase 16, SRC-318)", () => {
    const policy = buildCsp("n", {
      scriptSrcOrigins: ["https://api.sendcms.bond"],
    })
    const scriptSrc =
      policy.split("; ").find((d) => d.startsWith("script-src")) ?? ""
    expect(scriptSrc).toContain("https://api.sendcms.bond")
    expect(scriptSrc).toContain("'nonce-n'")
    expect(scriptSrc).toContain("'strict-dynamic'")
    // Default: no extra script origin.
    expect(buildCsp("n")).not.toContain("https://api.sendcms.bond")
  })

  it("swaps the style nonce for unsafe-inline only for the api app (Phase 16, SEC-303)", () => {
    // The api app's branded 404 page renders an authored <style>
    // block that Next does not nonce — the standard nonce-gated
    // style-src would strip its styling.
    const apiPolicy = buildCsp("n", { allowInlineStyles: true })
    expect(apiPolicy).toContain("style-src 'self' 'unsafe-inline'")
    expect(apiPolicy).not.toContain("style-src 'self' 'nonce-n'")
    // Script-src stays nonce-gated and strict for the api app too.
    expect(apiPolicy).toContain("script-src 'self' 'nonce-n' 'strict-dynamic'")
    // Every other app keeps the nonce on style-src.
    expect(buildCsp("n")).toContain("style-src 'self' 'nonce-n'")
  })

  it("creates a fresh base64 nonce on every call", () => {
    const a = createCspNonce()
    const b = createCspNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    // The nonce is the base64 of a UUID — decoding it gives the UUID back.
    expect(Buffer.from(a, "base64").toString("utf8")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it("names the report-only and enforcing headers", () => {
    expect(cspHeaderName(true)).toBe("Content-Security-Policy-Report-Only")
    expect(cspHeaderName(false)).toBe("Content-Security-Policy")
    expect(CSP_HEADER_NAME).toBe("Content-Security-Policy")
    expect(CSP_REPORT_ONLY_HEADER_NAME).toBe(
      "Content-Security-Policy-Report-Only"
    )
  })

  it("ships enforcing — the report-only run is done and the flip landed", () => {
    expect(CSP_REPORT_ONLY).toBe(false)
  })

  it("keeps CSP out of the committed _headers files", () => {
    // A nonce policy cannot live in a static file. The _headers files
    // do mention CSP in a comment (explaining why it is absent) — the
    // assertion is on header lines, not on the word itself.
    for (const app of [
      "marketing",
      "api",
      "dashboard",
      "docs",
      "updates",
      "admin",
    ]) {
      const file = readFileSync(`apps/${app}/public/_headers`, "utf8")
      const headerLines = file
        .split("\n")
        .filter((line) => line.trim().startsWith("Content-Security-Policy:"))
      expect(headerLines, `${app}/public/_headers`).toEqual([])
    }
  })
})

describe("logAudit", () => {
  beforeEach(() => {
    mockCreate.mockReset()
    mockLoggerError.mockReset()
  })

  it("writes the audit row with the caller's fields", async () => {
    mockCreate.mockResolvedValue({})
    await logAudit({
      userId: "user-1",
      action: AuditAction.CREATE,
      resourceType: AuditResource.DOMAIN,
      resourceId: "domain-1",
      detail: { domain: "example.com" },
    })
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: AuditAction.CREATE,
        resourceType: AuditResource.DOMAIN,
        resourceId: "domain-1",
        detail: { domain: "example.com" },
        ipAddress: undefined,
        userId: "user-1",
      },
    })
  })

  it("never throws — a failing write is logged, not raised", async () => {
    mockCreate.mockRejectedValue(new Error("db down"))
    await expect(
      logAudit({
        action: AuditAction.DELETE,
        resourceType: AuditResource.SUBMISSION,
        resourceId: "sub-1",
      })
    ).resolves.toBeUndefined()
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
  })

  it("treats a unique-violation as already logged (DB-004/SRC-331)", async () => {
    // The partial unique index on (correlationId, action, resourceType,
    // resourceId) fires when a concurrent retry already inserted the
    // row — that is the idempotent outcome, not a failure.
    mockCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      })
    )
    await expect(
      logAudit({
        action: AuditAction.CREATE,
        resourceType: AuditResource.DOMAIN,
        resourceId: "domain-1",
        correlationId: "corr-1",
      })
    ).resolves.toBeUndefined()
    expect(mockLoggerError).not.toHaveBeenCalled()
  })
})

describe("isValidBearerToken (SRC-115 / EML-067)", () => {
  const SECRET = "test-cron-secret"

  it("accepts the canonical Bearer scheme", () => {
    expect(isValidBearerToken(`Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  it("accepts a lowercase bearer scheme (RFC 9110 / RFC 6750)", () => {
    expect(isValidBearerToken(`bearer ${SECRET}`, SECRET)).toBe(true)
    expect(isValidBearerToken(`BeArEr ${SECRET}`, SECRET)).toBe(true)
  })

  it("rejects a wrong token, including one of a different length", () => {
    expect(isValidBearerToken("Bearer wrong-secret", SECRET)).toBe(false)
    expect(isValidBearerToken("Bearer short", SECRET)).toBe(false)
    expect(isValidBearerToken(`Bearer ${SECRET}-with-extra`, SECRET)).toBe(
      false
    )
  })

  it("rejects a missing/empty header, a missing secret, and a non-Bearer scheme", () => {
    expect(isValidBearerToken(null, SECRET)).toBe(false)
    expect(isValidBearerToken(undefined, SECRET)).toBe(false)
    expect(isValidBearerToken("", SECRET)).toBe(false)
    expect(isValidBearerToken(`Bearer ${SECRET}`, "")).toBe(false)
    expect(isValidBearerToken(`Bearer ${SECRET}`, null)).toBe(false)
    expect(isValidBearerToken(`Basic ${SECRET}`, SECRET)).toBe(false)
    expect(isValidBearerToken(SECRET, SECRET)).toBe(false)
    expect(isValidBearerToken("Bearer ", SECRET)).toBe(false)
  })
})
