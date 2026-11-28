# Content-Security-Policy (Admin Control Plane, Phase 9)

SendCMS serves a nonce-based Content-Security-Policy on every document
response from the five page-serving apps (marketing, dashboard, docs,
updates, admin). The api app serves no HTML — JSON responses and the
SDK bundle — so it has no CSP at all.

## The policy

Built per request by `buildCsp(nonce, options)` in
`packages/security/src/csp.ts` (the builder is the single source of
truth — the proxies and the tests both use it):

```
default-src 'self';
script-src 'self' 'nonce-…' 'strict-dynamic';
style-src 'self' 'nonce-…';
style-src-attr 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

The dashboard, admin, and marketing apps add one directive (see
"Per-app inventory" below):

```
connect-src 'self' <api origin>
```

There is no `'unsafe-inline'` in `script-src` or in `style-src`
(`<style>` elements still need the nonce). The one exception is
`style-src-attr 'unsafe-inline'`, which covers ONLY `style="..."`
attributes — see the `style-src` bullet below. The policy is served
as the enforcing `Content-Security-Policy` header (see "Report-only
first" below).

### Why each directive is what it is

- `default-src 'self'` — anything not listed is same-origin.
- `script-src 'self' 'nonce-…' 'strict-dynamic'` — Next.js's own
  inline scripts carry the per-request nonce; a nonced script may
  load further scripts (`strict-dynamic`). The demo page's SDK script
  is loaded this way (see below) — no host allowlist is needed for
  it.
- `style-src 'self' 'nonce-…'` — same shape for `<style>` elements.
- `style-src-attr 'unsafe-inline'` — style ATTRIBUTES only. A nonce
  does not cover `style="..."` attributes, and the apps set inline
  styles (the shadcn sidebar's `--sidebar-width` vars, Radix
  floating-UI positioning, chart sizing). The first enforcing deploy
  (2026-11-22) shipped without this: the browser silently dropped
  the sidebar width variable, the sidebar gap collapsed to 0, and
  page content slid under the fixed sidebar on dashboard and admin
  (LTR and RTL). The fix — this directive, one line in `buildCsp` —
  restores those styles; `<style>` elements still need the nonce
  and scripts stay strict. The test pins all three facts
  (`tests/security.test.ts`).
- `connect-src 'self' <api origin>` — the dashboard, admin, and
  marketing apps add this (the builder only emits it when an
  `apiOrigin` is passed). There is no nonce mechanism for `fetch`:
  the dashboard's browser auth client posts to the api app, the
  admin's sign-out posts there too, and marketing's demo REST tab
  fetches the submit API — all cross-origin. The first enforcing
  deploy (2026-11-22) shipped without it on dashboard/admin: the
  browser blocked every auth request with `TypeError: Failed to
fetch`, and the social buttons silently did nothing (found live
  2026-11-23). The Phase 9 inventory had claimed the dashboard has
  no cross-origin source — wrong: it missed the auth client. The
  fix adds the origin to the dashboard and admin proxies, same
  pattern as marketing.
- `img-src 'self' blob: data:` — same-origin images, plus `blob:`
  (download previews created with `URL.createObjectURL`) and `data:`
  (inline SVG / data-URI images).
- `font-src 'self'` — fonts are self-hosted. The apps use
  `next/font/google` (Geist), which downloads the font files at build
  time and serves them from `/_next/static` — no Google Fonts request
  happens at runtime.
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — no
  plugins, no foreign base element, forms post back to the same
  origin.
- `frame-ancestors 'none'` — no SendCMS page may be framed, by anyone.
  This is STRICTER than the existing `X-Frame-Options: SAMEORIGIN`
  in `packages/security/src/headers.mjs`: where both headers are set,
  the CSP directive wins, so the effective framing policy is now
  "none". That is deliberate — nothing in SendCMS is designed to be
  embedded in another page.
- `upgrade-insecure-requests` — http subresources upgrade to https.

## The nonce mechanism

Per request, the app's `proxy.ts` (Next.js middleware) generates a
nonce — `Buffer.from(crypto.randomUUID()).toString("base64")` — and
sets it in two places:

1. On the REQUEST headers: `x-nonce` + the CSP header itself. Next.js
   reads the nonce from the request's CSP header and applies it to
   the inline scripts and styles it renders (the RSC flight-data
   scripts, the chunk `<script>` tags, the style tags). This is the
   mechanism from the Next.js docs.
2. On the RESPONSE header: the same CSP header, so the browser
   enforces it.

The header also rides on the redirect responses the dashboard/admin
proxies return (browsers ignore CSP on redirects — it is there so the
header is observable on the unauthenticated path too).

One inline script Next.js does NOT nonce: the theme script
`next-themes` renders (`<script>((e, i, s, u, m, a, l, h)=>{…`) —
it is a user component's script element, not one of Next's own, so
the nonce has to be threaded through explicitly. Each app's root
layout reads the nonce from the request headers (`headers()` →
`x-nonce`) and passes it to the shared `ThemeProvider`
(`@sendcms/ui` forwards it to `NextThemesProvider`'s `nonce` prop,
which renders it on the script tag). Without this, the enforcing
policy would block the theme script on every page. The report-only
run caught exactly this: the theme script was the only executable
script without a nonce, and the fix was verified in dev before the
flip (see "Verification" below).

The one remaining nonce-less script tag is the JSON-LD block on the
marketing homepage (`<script type="application/ld+json">`). That is a
data block, not an executed script — CSP `script-src` does not apply
to it — so it needs no nonce.

### Cost: dynamic rendering

A nonce forces dynamic rendering on the matched routes: Next.js
cannot prerender a page whose inline scripts need a per-request
nonce. That is the accepted cost. The matched routes are the
document routes of the five page apps; static assets are excluded by
the proxy matchers (below), so they keep their normal caching.

Reading the nonce in the root layout (`headers()`) has the same
effect on the layout's routes — including the dashboard's `/sign-in`
page, which is outside the proxy matcher and carries no CSP header.
That page is a login form; dynamic rendering there is fine.

## Matchers

- marketing / docs / updates — the proxy matches every document
  path and excludes static assets:
  `"/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"`. The
  extension exclusion is what keeps the static HTML demo page
  (`/demo/contact-us.html`) out: it is a static file with inline
  `<style>` and `<script>` no nonce can be injected into, so any CSP
  header on it would break it. It loads exactly as before, with no
  CSP header. Sitemaps, `robots.txt`, and the other extension paths
  are excluded the same way (they are not documents).
- dashboard — matcher unchanged: `/dashboard/:path*`. The gating
  logic is unchanged. The sign-in page lives outside the matcher and
  gets NO CSP header in this pass — covering it needs an auth
  exemption in the gating logic (an unauthenticated request to
  `/sign-in` must not redirect to itself), which is a follow-up, not
  a silent change here.
- admin — matcher unchanged: `/admin/:path*`. The gating logic is
  unchanged.

## Per-app inventory (what the policy had to allow)

Inventoried 2026-11-22 (source + live dev responses) before the
policy was written; the policy allows ONLY what the inventory proves
necessary.

- **marketing** — the only app with a cross-origin source. Its demo
  page (`/demo/contact-us`) loads the SDK script from the api origin
  (`next/script`, `${api}/forms/v1.js`, where `api` is
  `NEXT_PUBLIC_API_URL` or `http://localhost:3001` in dev) and its
  REST tab fetches `${api}/api/public/v1/submit` cross-origin. The
  script load is covered by the nonce + `strict-dynamic` (Next
  preloads it with the nonce; the after-interactive injection is done
  by a nonced script), so `script-src` needs no host. The `fetch`
  has no nonce mechanism, so the policy adds `connect-src 'self'
<api origin>` for marketing only. The homepage's embed snippet is
  displayed as text, not executed. No external fonts, images,
  iframes, or analytics anywhere in the app.
- **dashboard** — one cross-origin source: its browser auth client
  (sign-in, sign-up, social OAuth) posts to the api app, so the
  policy adds `connect-src 'self' <api origin>`. Its `/api/v1/*`
  data fetches go through the same-origin rewrite (proxied to the
  api app server-side), so `default-src 'self'` covers those.
  Turnstile is only a per-form setting flag — no widget is loaded
  in the app. Downloads use `URL.createObjectURL` (`blob:`),
  covered by `img-src`. (Correction 2026-11-23: the Phase 9
  inventory said "no external sources" — it missed the auth
  client, which is why the social buttons broke under the first
  enforcing deploy.)
- **docs** — renders repo markdown via `dangerouslySetInnerHTML`; no
  `<script>` in any doc, no external images. Base policy only.
- **updates** — static changelog. Base policy only.
- **admin** — Recharts charts, plus one cross-origin source: the
  sidebar sign-out posts to the api app, so the policy adds
  `connect-src 'self' <api origin>` like the dashboard.
- **api** — no HTML, no CSP. The SDK bundle (`/forms/v1.js`) and the
  JSON routes carry no CSP header.

## Report-only first, then enforce

The pass shipped in two steps, in the same phase:

1. **Report-only.** `CSP_REPORT_ONLY = true` in
   `packages/security/src/csp.ts` served the policy as
   `Content-Security-Policy-Report-Only`. Verified in dev on all five
   apps (see "Verification"). The run caught the un-nonced theme
   script (above); the fix landed and was re-verified before the
   flip.
2. **Enforce.** One line — `CSP_REPORT_ONLY = false` — flipped the
   header name to the enforcing `Content-Security-Policy`. Re-verified
   in dev on all five apps. The test
   `tests/security.test.ts > ships enforcing` pins the shipped state:
   it fails while the flag is `true`.

To diagnose a live violation without blocking, flip the flag back to
`true` temporarily (report-only again).

## Violation reports (`POST /api/csp-report`)

Every app's enforcing policy carries
`report-uri <api origin>/api/csp-report` (built by `buildCsp` in
`packages/security/src/csp.ts`; the docs/updates proxies point their
reports at the same endpoint), so a browser that blocks something
under the policy POSTs the violation here instead of dropping it
silently. The route lives at
`apps/api/app/api/csp-report/route.ts`:

- **Purpose:** receive CSP violation reports and log them — nothing
  else. It never touches the database and never requires auth
  (browsers send reports without credentials).
- **Always 204:** the route answers `204` with
  `Cache-Control: no-store`, even for a malformed or empty body — a
  reporting failure must never fail the browser's report (or the
  request that triggered it), so the handler never throws.
- **16 KB cap:** the body is truncated to 16,384 bytes before parsing,
  so a flood of reports costs one log line each and nothing else.
- **Parsing is lenient:** the classic `report-uri` shape nests the
  fields under `csp-report`; the newer Reporting API shape sends them
  flat. Both are accepted; unparseable JSON is logged as an `unparsed`
  snippet (first 200 characters), never a 500.
- **Logged fields:** `document-uri`, `blocked-uri`,
  `violated-directive`, `effective-directive`, `original-policy`,
  `source-file`, `line-number` (via the `csp-report` logger scope).

## Verification (dev, 2026-11-22)

Dev servers started one app at a time (`next dev` directly from the
app directory — the `pnpm dev` scripts wrap `dotenv`, which refuses
to run without a root `.env`; the sandbox has none, and serving pages
needs no env vars). No `DATABASE_URL` in the sandbox: the dashboard
and admin proxies were verified on their unauthenticated paths only
(the session lookup short-circuits with no cookie, so the redirects
still work); document-level nonce matching on a signed-in dashboard /
admin page is NOT verified here and should be confirmed in a
signed-in browser.

Report-only run — header `Content-Security-Policy-Report-Only`
present, nonce in the header matches the nonce attributes in the
HTML, pages complete:

| App       | Page                    | Status                   | Header                 | Nonce match           |
| --------- | ----------------------- | ------------------------ | ---------------------- | --------------------- |
| marketing | `/`                     | 200                      | report-only            | yes (after theme fix) |
| marketing | `/demo/contact-us`      | 200                      | report-only            | yes (after theme fix) |
| marketing | `/demo/contact-us.html` | 200                      | none (expected)        | —                     |
| marketing | `/_next/static/…css`    | 200                      | none (expected)        | —                     |
| docs      | `/`                     | 404 (no root route)      | report-only            | yes                   |
| docs      | `/docs/getting-started` | 200                      | report-only            | yes                   |
| docs      | `/docs/sdk`             | 200                      | report-only            | yes                   |
| updates   | `/`                     | 404 (no root route)      | report-only            | yes                   |
| updates   | `/changelog`            | 200                      | report-only            | yes                   |
| dashboard | `/dashboard`            | 307 → `/sign-in`         | report-only            | — (redirect)          |
| dashboard | `/dashboard/inbox`      | 307 → `/sign-in`         | report-only            | — (redirect)          |
| dashboard | `/sign-in`              | 200                      | none (outside matcher) | —                     |
| admin     | `/admin`                | 307 → sign-in + callback | report-only            | — (redirect)          |
| admin     | `/admin/users`          | 307 → sign-in + callback | report-only            | — (redirect)          |
| api       | `/forms/v1.js`          | 200 (7,449 bytes)        | none (expected)        | —                     |

Enforcing run — header `Content-Security-Policy` present,
`Content-Security-Policy-Report-Only` absent, same checks:

| App       | Page                                 | Status   | Nonce match  |
| --------- | ------------------------------------ | -------- | ------------ |
| marketing | `/`, `/demo/contact-us`              | 200, 200 | yes, yes     |
| docs      | `/docs/getting-started`, `/docs/sdk` | 200, 200 | yes, yes     |
| updates   | `/changelog`                         | 200      | yes          |
| dashboard | `/dashboard`, `/dashboard/inbox`     | 307, 307 | — (redirect) |
| admin     | `/admin`, `/admin/users`             | 307, 307 | — (redirect) |

Every check also confirmed a fresh nonce per request (two requests
never share a nonce) and zero executable `<script>` tags without a
nonce on the verified documents (the only exception is the JSON-LD
data block, which is exempt).

## What was deliberately NOT done

- `packages/security/src/headers.mjs` and every `public/_headers`
  file are untouched — a nonce policy cannot live in a static file.
  The tests assert the `_headers` files contain no CSP header line.
- The api app has no CSP (no HTML). Its routes also need no CSP.
- The dashboard `/sign-in` page has no CSP header (outside the
  matcher — see "Matchers"). Follow-up, not done silently here.
- No `'unsafe-inline'` in `script-src` or `style-src`, no hash
  allowlists, no new dependencies. The only `'unsafe-inline'` is
  `style-src-attr`, scoped to style attributes (see above).
- The CSP builder is imported by the proxies (and the tests) from the
  `@sendcms/security/csp` subpath entry (`packages/security/src/csp.ts`),
  not from the `@sendcms/security` barrel (DOC-024, Phase 16, Wave 12):
  the barrel also re-exports the db-backed audit writer, rate limiter,
  and step-up helpers, and the proxies must not pull those into their
  import graph. The split is hygiene — the build never failed on the
  barrel import — not a build fix.
