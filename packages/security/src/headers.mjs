/**
 * Single source of truth for SendCMS's security headers (Phase 10).
 *
 * Plain `.mjs` on purpose: the apps' `next.config.mjs` files import it
 * by relative path, and plain Node (which loads the Next config) cannot
 * import TypeScript. The same data renders both shapes:
 *
 * - `securityHeaders()` — the Next.js `headers()` config entries, used
 *   by every app's next.config.mjs (covers every route the Next server
 *   handles, in dev and on any host).
 * - `renderHeadersFile()` — the Cloudflare `_headers` file text, used
 *   for each app's `public/_headers` (covers static assets served by
 *   Cloudflare's asset layer). `tests/security.test.ts` asserts the
 *   committed `_headers` files match this output, so the two shapes
 *   can't drift apart.
 *
 * The `/_next/static/*` immutable Cache-Control lives ONLY in the
 * `_headers` file, not in `securityHeaders()`: Next.js already sets
 * `immutable` for its static chunks in production, and a custom
 * Cache-Control there makes Next warn that it can break development
 * behavior (dev chunks would be cached). The asset layer is
 * production-only, so the file is the right place for it.
 *
 * No Content-Security-Policy here on purpose: Next.js inlines
 * scripts/styles, so a CSP needs `unsafe-inline` to work at all and
 * adds nothing then — a real CSP is a separate, tested pass.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
]

const STATIC_CACHE_HEADER = {
  key: "Cache-Control",
  value: "public, max-age=31536000, immutable",
}

export function securityHeaders() {
  return [
    {
      source: "/:path*",
      headers: SECURITY_HEADERS,
    },
  ]
}

export function renderHeadersFile() {
  const lines = [
    "# Security headers — generated from @sendcms/security (src/headers.mjs).",
    "# No Content-Security-Policy here on purpose: Next.js inlines scripts/styles, so a CSP needs `unsafe-inline` to work at all and adds nothing then — a real CSP is a separate, tested pass.",
    "/*",
    ...SECURITY_HEADERS.map((h) => `  ${h.key}: ${h.value}`),
    "",
    "/_next/static/*",
    `  ${STATIC_CACHE_HEADER.key}: ${STATIC_CACHE_HEADER.value}`,
    "",
  ]
  return lines.join("\n")
}
