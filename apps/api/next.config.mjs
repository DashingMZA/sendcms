import path from "path"
import { fileURLToPath } from "url"
import { securityHeaders } from "../../packages/security/src/headers.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/api. See the turbopack.root docs.
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
  // (eslint.config.mjs only, never bundled). `@sendcms/shared` is
  // kept: it is imported transitively by `@sendcms/api-client`.
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/api-client",
    "@sendcms/database",
    "@sendcms/auth",
    "@sendcms/permissions",
    "@sendcms/email",
    "@sendcms/domains",
    "@sendcms/forms",
    "@sendcms/submissions",
    "@sendcms/inbox",
    "@sendcms/notifications",
    "@sendcms/api-keys",
    "@sendcms/mcp",
    "@sendcms/observability",
    "@sendcms/security",
    "@sendcms/ai",
    "@sendcms/users",
    "@sendcms/admin-users",
    "@sendcms/ai-settings",
    "@sendcms/billing",
    "@sendcms/coupons",
    "@sendcms/cron",
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
        source: "/api/:path*",
        headers: [
          // Cache-Control (Phase 16, PRF-009): API responses are
          // never public/cacheable — a shared cache must not serve a
          // stale "ok" after the database dies.
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // PRF-003 (Phase 16, Wave 11): the form SDK bundle is served
        // from `public/forms/` on every third-party embed. The
        // filename is unversioned (`v1.js` is overwritten on each
        // deploy), so `immutable` would be wrong — but the default
        // `max-age=0, must-revalidate` forced an origin revalidation
        // on every embed load. Edge caches it a day; browsers
        // revalidate (they get a fresh copy at most a day stale, and
        // a deploy busts the edge entry via SWR).
        source: "/forms/:path*",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // PRF-004 (Phase 16, Wave 11): same rule for the api app's
        // public images + favicon — content changes only on redeploy.
        // `/_next/image` is deliberately NOT listed: the optimizer
        // sets its own caching.
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
      {
        // X-Robots-Tag (Phase 16, PRF-034): the api app is not for
        // crawlers either — every path, not just /api/*, so the 404
        // page and robots.txt carry it too.
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ]
  },
}

export default nextConfig
