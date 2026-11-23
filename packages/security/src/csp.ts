/**
 * Content-Security-Policy builder (Admin Control Plane, Phase 9).
 *
 * The policy is built per request with a fresh nonce. The nonce comes
 * from `crypto.randomUUID()` (base64) and is set on the REQUEST
 * headers (`x-nonce` + the CSP header) so Next.js can apply it to the
 * inline scripts and styles it renders itself, and on the RESPONSE
 * header so the browser enforces it. This is the mechanism from the
 * Next.js docs — do not move the policy into `headers.mjs` or any
 * `public/_headers` file: a nonce policy cannot live in a static
 * file, and `headers.mjs` is intentionally untouched by this pass.
 *
 * Cost, accepted: a nonce forces dynamic rendering on the matched
 * routes (Next.js cannot prerender a page whose inline scripts need
 * a per-request nonce). The matched routes are the document routes
 * of the five page-serving apps; static assets are excluded by the
 * proxy matchers.
 *
 * Sequence: this ships as `Content-Security-Policy-Report-Only`
 * first (`CSP_REPORT_ONLY = true`). Once the report-only run is
 * clean in dev, flip that one constant to `false` and the same policy
 * is served as the enforcing `Content-Security-Policy` header.
 *
 * The policy (Next.js docs shape, extended only where the per-app
 * inventory proves a source is real):
 * - `default-src 'self'` — everything not listed below is same-origin.
 * - `script-src 'self' 'nonce-…' 'strict-dynamic'` — Next's inline
 *   scripts carry the nonce; a nonced script may load further scripts
 *   (`strict-dynamic`). No `'unsafe-inline'`, ever.
 * - `style-src 'self' 'nonce-…'` — same shape for `<style>` elements.
 * - `style-src-attr 'unsafe-inline'` — style ATTRIBUTES only. A nonce
 *   does not cover `style="..."` attributes, and the apps set inline
 *   styles (the shadcn sidebar's `--sidebar-width` vars, Radix
 *   floating-UI positioning, chart sizing). Without this, the
 *   enforcing policy silently drops those styles — the sidebar gap
 *   collapses to 0 and page content slides under the fixed sidebar
 *   (found live 2026-11-22, the day enforcing CSP shipped).
 *   `<style>` elements still need the nonce; scripts stay strict.
 * - `img-src 'self' blob: data:` — same-origin images, plus blob:
 *   (download previews) and data: (inline SVG / data-URI images).
 * - `font-src 'self'` — no external font host is used (no next/font,
 *   no Google Fonts); fonts are served from the app itself.
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` —
 *   no plugins, no foreign base, forms post back to the same origin.
 * - `frame-ancestors 'none'` — no app may be framed at all. This is
 *   STRICTER than the existing `X-Frame-Options: SAMEORIGIN` in
 *   `headers.mjs`: where both are set, the CSP directive wins, so
 *   the effective framing policy is now "none". That is deliberate —
 *   nothing in SendCMS is designed to be embedded.
 * - `upgrade-insecure-requests` — http subresources upgrade to https.
 * - `connect-src 'self' <api origin>` — the dashboard, admin, and
 *   marketing apps pass the api origin. There is no nonce mechanism
 *   for `fetch`, so `default-src 'self'` alone would block a
 *   cross-origin fetch: the dashboard's browser auth client posts
 *   to the api app (the Better Auth handler lives there — sign-in,
 *   sign-up, and the social OAuth flow all go through it), the
 *   admin's sign-out posts there too, and marketing's demo REST tab
 *   fetches the public submit API (`${api}/api/public/v1/submit`).
 *   The dashboard's `/api/v1/*` data fetches stay same-origin (the
 *   proxy rewrites them to the api app server-side), but the auth
 *   client cannot go through that rewrite. Docs and updates pass no
 *   origin and fall back to `default-src 'self'`.
 * - The marketing demo page also loads the SDK script from the api
 *   origin (`next/script`, `${api}/forms/v1.js`). It is NOT allow-
 *   listed in `script-src` up front: if Next.js applies the nonce to
 *   that script tag, the nonce covers it. The dev verification checks
 *   exactly that — if the tag carries no nonce, the api origin is
 *   added to `script-src` for marketing before enforcing.
 * - The static HTML demo page (`public/demo/contact-us.html`) is NOT
 *   covered at all: it is a static file with inline `<style>` and
 *   `<script>`, so no nonce can be injected into it, and any CSP
 *   would break it. The proxy matchers exclude it (and every other
 *   path with a file extension) — it keeps loading as before.
 */
import { Buffer } from "node:buffer"

// Report-only first, enforcing after the report-only run is clean.
// The report-only run is done (2026-11-22, dev-verified on all five
// page apps) — this now ships enforcing. Flip back to `true` only to
// diagnose a live violation without blocking.
export const CSP_REPORT_ONLY = false

export const CSP_HEADER_NAME = "Content-Security-Policy"
export const CSP_REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only"

export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? CSP_REPORT_ONLY_HEADER_NAME : CSP_HEADER_NAME
}

export function createCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64")
}

export interface CspOptions {
  // Origin of the api app (the auth handler + the public submit API),
  // e.g. `https://api.sendcms.bond` in production,
  // `http://localhost:3001` in dev. The dashboard, admin, and
  // marketing apps pass it — see the header comment. Omit it and the
  // policy has no `connect-src` (it falls back to `default-src
  // 'self'`).
  apiOrigin?: string
}

export function buildCsp(nonce: string, options: CspOptions = {}): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]
  if (options.apiOrigin) {
    directives.push(`connect-src 'self' ${options.apiOrigin}`)
  }
  return directives.join("; ")
}
