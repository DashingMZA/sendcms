import path from "path"
import { fileURLToPath } from "url"
import { securityHeaders } from "../../packages/security/src/headers.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/admin. See ADR 0004.
const workspaceRoot = path.resolve(__dirname, "../..")

/** @type {import('next').NextConfig} */
const nextConfig = {
  // X-Powered-By (Phase 16, SEC-302): suppress the `X-Powered-By:
  // Next.js` header on every document response.
  poweredByHeader: false,
  // PRF-008 (Phase 16, Wave 11): the Logo is the only next/image user
  // in the repo and displays at max 160px wide — 160/320w srcset
  // candidates only (the default imageSizes start at 16 and the
  // deviceSizes at 640, which served a 640w logo for a 160px slot).
  images: {
    imageSizes: [160, 320],
  },
  // DOC-026 (Phase 16, Wave 12): regenerated from the packages this
  // app actually imports — `@sendcms/config` is deliberately absent
  // (eslint.config.mjs only, never bundled). Dropped as unimported
  // (verified by import analysis, not by a build — see below):
  // `@sendcms/analytics`, `@sendcms/api-keys`, `@sendcms/domains`,
  // `@sendcms/email`, `@sendcms/forms`, `@sendcms/inbox`,
  // `@sendcms/sdk` — the admin app reaches those through the api app,
  // not direct imports. NOTE: `build:server` for this app currently
  // fails on a PRE-EXISTING Turbopack error unrelated to this list
  // (`packages/security/src/step-up.ts:207` `readFileSync`, pulled
  // into the middleware bundle via the `@sendcms/security` barrel —
  // the same error reproduces with the pre-DOC-026 list), so the drop
  // could not be build-verified; consolidation must re-verify once
  // that error is fixed (see DOC-024: splitting the CSP helpers out
  // of the barrel would remove it from the bundle).
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/ui",
    "@sendcms/database",
    "@sendcms/auth",
    "@sendcms/permissions",
    "@sendcms/users",
    "@sendcms/notifications",
    "@sendcms/observability",
    "@sendcms/security",
    "@sendcms/i18n",
    "@sendcms/ai",
    "@sendcms/admin-users",
    "@sendcms/ai-settings",
    "@sendcms/billing",
    "@sendcms/coupons",
    "@sendcms/cron",
    "@sendcms/mcp",
    "@sendcms/mcp-admin",
    "@sendcms/plans",
    "@sendcms/platform-ops",
    "@sendcms/support",
  ],
  turbopack: {
    root: workspaceRoot,
  },
  // Security headers (Phase 10): the shared definition lives in
  // packages/security/src/headers.mjs — imported by relative path
  // because plain Node (which loads this config) cannot import
  // TypeScript. The matching `public/_headers` file covers static
  // assets on Cloudflare's asset layer.
  async headers() {
    return [
      ...securityHeaders(),
      {
        // X-Robots-Tag (Phase 16, PRF-034): this is an authenticated
        // app — defence in depth alongside robots.txt + metadata
        // noindex, so a crawler that ignores one still sees this.
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      // PRF-001 (Phase 16, Wave 11): session-dependent routes are
      // `no-store` — explicitly, not just by Next's dynamic default —
      // so a future static-ification of a page can never silently
      // start serving one user's session HTML to another. The list
      // is the session-aware surface: the `/` landing (awaits
      // auth()) and `/admin/*`. Public images + favicon keep the
      // PRF-004 rule below (disjoint paths).
      ...["/", "/admin/:path*"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "no-store" }],
      })),
      {
        // PRF-004 (Phase 16, Wave 11): public images + favicon change
        // only on redeploy — edge caches them a day, browsers
        // revalidate. `/_next/image` is deliberately NOT listed: the
        // optimizer sets its own caching.
        source: "/images/:path*",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
          },
        ],
      },
    ]
  },
  // Admin API proxy (monorepo split): the admin app's client-side
  // fetches (apiFetch, relative /api/v1/* paths) assume the API lives
  // on the same origin, but the /api/v1/* routes live on the api app
  // (port 3001). Proxying keeps the browser same-origin, so the admin
  // routes need no CORS (see route-creation.md: "No CORS needed") and
  // the session cookie is forwarded to the api app. The destination
  // is the api app's URL (NEXT_PUBLIC_API_URL, dev localhost:3001).
  async rewrites() {
    const apiUrl = (
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
    ).replace(/\/+$/, "")
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiUrl}/api/v1/:path*`,
      },
    ]
  },
}

export default nextConfig
