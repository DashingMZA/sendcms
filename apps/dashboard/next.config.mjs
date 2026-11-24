import path from "path"
import { fileURLToPath } from "url"
import { securityHeaders } from "../../packages/security/src/headers.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/dashboard. See ADR 0004.
const workspaceRoot = path.resolve(__dirname, "../..")

/** @type {import('next').NextConfig} */
const nextConfig = {
  // X-Powered-By (Phase 16, SEC-302): suppress the `X-Powered-By:
  // Next.js` header on every document response.
  poweredByHeader: false,
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/ui",
    "@sendcms/database",
    "@sendcms/auth",
    "@sendcms/permissions",
    "@sendcms/email",
    "@sendcms/api-client",
    "@sendcms/sdk",
    "@sendcms/domains",
    "@sendcms/forms",
    "@sendcms/inbox",
    "@sendcms/notifications",
    "@sendcms/users",
    "@sendcms/analytics",
    "@sendcms/api-keys",
    "@sendcms/observability",
    "@sendcms/security",
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
    ]
  },
  // Admin API proxy (monorepo split): the dashboard's client-side
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
