import path from "path"
import { fileURLToPath } from "url"
import { securityHeaders } from "../../packages/security/src/headers.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/updates. See ADR 0004.
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
  transpilePackages: ["@sendcms/shared", "@sendcms/ui", "@sendcms/content"],
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
}

export default nextConfig
