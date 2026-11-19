# ADR 0005 — Dashboard app and API app (Phase 7)

- Status: accepted (2026-11-18, Phase 7)
- Context: the audit's Phase 7 — the dashboard and auth pages become
  `apps/dashboard`, and the remaining 20 API routes move into `apps/api`
  (the health route moved there in Phase 6). Exit criteria: "Dashboard +
  auth flows work; session/cookie behavior unchanged".

## Decision

### `packages/email` pulled forward from Phase 9

The auth split forces it: both new apps need the mailer, and the mailer
is already a standalone library (env-driven, no app dependencies). So
`lib/email/` moved verbatim via `git mv` to `packages/email`
(`@sendcms/email`): provider (Resend → SMTP → none), platform
transport, transport helpers, auth mailer, notification deps, and the
four React Email templates. Its barrel exports the send functions,
`notificationDeps`, and — for the mailer tests — the transport builders
(`formatFromAddress`, `buildPlatformTransporter`,
`getPlatformFromAddress`) plus the submission-notification template
(`SubmissionNotification`, `submissionNotificationText`). Deps:
`@sendcms/notifications` (types), `@react-email/render`, `nodemailer`,
`react-email` (templates).

Phase 9 keeps the queue abstraction + `services/email-worker`, and
removes the two injections this phase leaves in place: the auth-mailer
injection (the `createSendcmsAuth(mailer)` factory parameter) and the
notification-deps injection (the `NotificationDeps` passed into
`processEmailOutbox` / `sendTestSubmissionEmail`). Pulling the package
forward changes Phase 9's scope, not its goal.

### Per-app auth wiring (the `lib/auth.ts` wrapper, twice)

Each Next.js app runs its own server and owns its own Better Auth
instance — the two apps cannot share one. So each app gets its own thin
`lib/auth.ts` (`apps/dashboard/lib/auth.ts`,
`apps/api/lib/auth.ts`), each calling `createSendcmsAuth` with the
mailer from `@sendcms/email` and re-exporting `betterAuth` / `auth()` /
`AdminSession`. The 37 `@/lib/auth` import sites in the moved files
needed NO change: each app's `@/*` alias resolves to its own `lib/`.
The root's `lib/auth.ts` was deleted (nothing in the root app imports
it anymore). `packages/auth` stays mailer-agnostic (the factory).

Session/cookie behavior: cookies are domain-scoped, not port-scoped,
so in dev the session cookie set by the api app (localhost:3001) is
sent to the dashboard app (localhost:3002) and the root app
(localhost:3000) alike — the cross-app session works unchanged. In
production the apps will sit on subdomains, where the cookie Domain
must be set (Phase 10 / infra concern, not a Phase 7 code change).

### Shared components: `Logo` + `ThemeProvider` → `packages/ui`

The audit mapped `components/logo.tsx` and `components/theme-*` to
apps/dashboard, but the recon showed they are shared:

- `Logo` is imported by the landing page, changelog, terms, the auth
  shell, the sign-in panel, AND the dashboard sidebar — six call sites
  across both apps. It moved to `packages/ui` with its brand values as
  a prop (`brand: LogoBrand` — the `config.site` object: logo,
  logo_darkmode, logo_width, logo_height, logo_text). It used to read
  them from the app's `config.json`; a UI package cannot import an
  app's config, so the config dependency became a prop. All six call
  sites pass `brand={config.site}` from their own app's config copy.
  `packages/ui` gained `next` as a devDep + peerDep (the Logo uses
  `next/image`).
- `ThemeProvider` is used by the root layout AND the dashboard app's
  layout — it moved to `packages/ui` (it only imports `next-themes`,
  already a ui dep).
- `ThemeToggle` and `ProductSchema` are landing-page-only (their only
  importers are the root layout / landing page), so they STAY at the
  root until Phase 8 (marketing). The audit mapping was wrong on these
  three files; the correction is recorded here.

### `apps/dashboard` (`@sendcms/dashboard`, dev port 3002)

Moved verbatim via `git mv`: `app/dashboard/*`, `app/(auth)/*`,
`app/(dashboard)/layout.tsx`, `components/dashboard/*`, and the root
`proxy.ts` (it gates `/dashboard/:path*` — it belongs to the dashboard
app). New: `app/layout.tsx` (modeled on the root layout — Geist fonts,
favicon from the app's config copy, `globals.css`, `ThemeProvider`,
`Toaster`, skip link), `lib/auth.ts` (see above), `tsconfig.json` /
`next.config.mjs` / `eslint.config.mjs` (mirroring `apps/api`,
`turbopack.root` = workspace root per ADR 0004).

The dashboard app owns copies of the assets it needs (the root keeps
its own for marketing): `app/globals.css` + `styles/` (design tokens +
component CSS), `config/config.json` (brand config — the two copies
must stay in sync until a shared config package lands), and
`public/images/` (favicon, logo, logo_darkmode). The SDK bundle stays
with the root app (it is the serving app until Phase 8).

The `(dashboard)` route group has NO pages — its layout is dormant.
It was moved verbatim (no behavior change); Phase 8 can delete it or
give it pages.

### Cross-app auth config (found during live verification)

The split broke auth in two places the recon did not surface, both
fixed in this phase:

- **Server origin check.** Better Auth's `baseURL` defaults to
  `http://localhost:3000` when `BETTER_AUTH_URL` is unset, so the api
  app (port 3001) rejected its own sign-up POSTs with
  `INVALID_ORIGIN` (the first journey run failed at step 1 with 403).
  The api app now runs with `BETTER_AUTH_URL=http://localhost:3001`
  (dev) / the api app's public URL (production).
- **Browser cross-origin.** The dashboard's pages post to the api
  app's auth handler from a different origin, so the factory gained
  `trustedOrigins` (env `TRUSTED_ORIGINS`, comma-separated — dev:
  `http://localhost:3002`) and the browser client gained a `baseURL`
  from `NEXT_PUBLIC_AUTH_URL` (dev: `http://localhost:3001`; unset =
  same-origin, the single-app case). Verified by a direct probe: a
  sign-in POST with `Origin: http://localhost:3002` reaches the
  credential check (401 for a bad password) instead of 403.
- **Absolute callback URLs.** The sign-up / sign-in / social forms
  passed `callbackURL: "/dashboard"` (relative). Client-side
  redirects are fine relative (the client runs on the dashboard app),
  but the SERVER-side redirects — the email verification link and the
  OAuth callback, both issued by the api app — would resolve a
  relative URL on the api app's origin and 404. The forms now pass
  `dashboardCallbackURL()` (`apps/dashboard/lib/callback-url.ts` =
  `${window.location.origin}/dashboard`, so it always matches where
  the page is actually served). The journey asserts the verify
  redirect's Location is the dashboard app's URL.

Deployment note (owner-side): the Google OAuth redirect URI must be
the api app's URL (`<api-app>/api/auth/callback/google`), not the
dashboard's — the callback lands on the api app now.

The remaining 20 routes moved verbatim via `git mv`
(`auth/[...all]`, `cron/email-outbox`, `public/v1/submit`,
`v1/domains` ×4, `v1/email-jobs`, `v1/forms` ×9, `v1/inbox` ×3) plus
its own `lib/auth.ts`. Its no-op `proxy.ts` (empty matcher, Phase 6)
stays — the api app has no middleware, and the empty-matcher proxy
stops Turbopack from picking up the dashboard's proxy (ADR 0004).
Package deps added: `@sendcms/auth`, `@sendcms/email`,
`@sendcms/domains`, `@sendcms/forms`, `@sendcms/submissions`,
`@sendcms/inbox`, `@sendcms/notifications`.

### The root app shrinks to marketing

`app/` now holds only the marketing site (landing, changelog, terms,
sitemap, robots, layout, globals); `lib/` only `content.ts`,
`text-converter.ts`, `utils.ts`; `components/` only `product-schema.tsx`

- `theme-toggle.tsx`. The root `package.json` dropped the workspace
  packages the app code no longer imports — but the test suite (which
  still lives at the root until Phase 13) imports 13 of them, so they
  came back as **devDependencies** (the app code imports only
  `@sendcms/shared` + `@sendcms/ui`). The root's `next.config.mjs`
  `transpilePackages` shrank to those two.

Two tsconfig consequences of the split:

- The root tsconfig's `include` (`**/*.ts`) now matches `apps/` and
  `packages/` too, so the root's `tsc` was typechecking the apps with
  the ROOT's `@/*` paths (e.g. `@/lib/auth` resolving to the deleted
  root wrapper — 108 errors). The root tsconfig now excludes `apps`
  and `packages`; each app/package is typechecked by its own config
  (`turbo run typecheck` runs all 17).
- The SDK test's `window.SendCMS` type comes from the global `Window`
  augmentation in `packages/sdk/src/index.ts`, which the root's `tsc`
  used to load via the `**/*.ts` include. The test now imports the
  types explicitly (`import type {} from "@sendcms/sdk"`).

The submit-route test imports the moved route by relative path
(`../apps/api/app/api/public/v1/submit/route`) with a comment — the
test suite stays at the root until Phase 13 co-locates tests with the
code they cover.

## Verification

- Root typecheck clean; `turbo run typecheck` 17/17.
- Lint 0 errors / 1 pre-existing warning (the `app/dashboard/error.tsx`
  `window.location.href` warning, now at its new path).
- Tests 202/202 (19 files).
- Builds: root 0, `build:cf` 0, apps/api 0, apps/dashboard 0.
- Live journey 44/44 (the 43 original checks + 1 new check asserting
  the verify redirect targets the dashboard app), exit 0, owner
  accounts intact (4). The journey spans all three dev servers
  (root :3000 serves the SDK bundle + test page, api :3001 owns
  /api/_, dashboard :3002 owns /dashboard/_ + the auth pages) — the
  dashboard pages load with the session cookie set by the api app
  (the cross-app session check). One re-run was needed: the second
  run's `/dashboard/api` page 500'd once with a transient
  "Connection terminated unexpectedly" from the remote dev DB pooler
  (the same page passed in the first and third runs) — a flake, not a
  code bug, re-run unchanged to 44/44. First run failed at step 1
  (403 INVALID_ORIGIN) — the cross-app auth fix above; reported
  plainly, not quoted as a clean first pass.

## Deferred / open

- Phase 8 (marketing app) takes the root app's remaining files.
- Phase 9 (queue + worker) removes the auth-mailer and
  notification-deps injections.
- The `config.json` and `styles/` copies (root + dashboard) must stay
  in sync until a shared config/styles package lands.
- Production cookie Domain for the subdomain split (Phase 10).
- SDK API origin (Phase 8): the SDK bundle is still served by the
  root app, but the submit API lives in the api app — the SDK's API
  origin (`__APP_URL__` / the script-src origin) must point at the
  api app, not the serving app, when the marketing app moves.
