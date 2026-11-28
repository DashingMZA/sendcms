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
 * No Content-Security-Policy here on purpose: the CSP is per-request
 * (it carries a fresh nonce — see `packages/security/src/csp.ts`,
 * `buildCsp` / `createCspNonce`), so it cannot live in this static
 * header list. Each app's proxy attaches it to every document
 * response (Admin Control Plane Phase 9); it ships enforcing
 * (`CSP_REPORT_ONLY = false`).
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
  // HSTS (Phase 16, SRC-301): HTTPS-only production subdomains send
  // this so browsers never downgrade to HTTP. `preload` is deliberately
  // NOT included: preloading commits every subdomain to HTTPS, and
  // that was not confirmed for all subdomains — add it only after that
  // confirmation. Browsers ignore this header on plain-HTTP (dev)
  // responses, so it is safe to send from every app.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
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
    "# No Content-Security-Policy here: the CSP is per-request (fresh nonce — see src/csp.ts) and each app's proxy attaches it; it ships enforcing.",
    "/*",
    ...SECURITY_HEADERS.map((h) => `  ${h.key}: ${h.value}`),
    "",
    "/_next/static/*",
    `  ${STATIC_CACHE_HEADER.key}: ${STATIC_CACHE_HEADER.value}`,
    "",
  ]
  return lines.join("\n")
}
