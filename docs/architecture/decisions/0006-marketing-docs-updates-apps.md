# ADR 0006 — Marketing, docs, and updates apps (Phase 8)

Date: 2026-11-18. Status: accepted (Phase 8 of the monorepo migration).
Implements audit §9 (marketing/docs/updates rows) + §10 Phase 8 exit
criteria: "Landing, changelog, terms, docs render; SEO routes
(sitemap/robots) keep working".

> **Snapshot note (Wave 12):** the app counts in this ADR ("all five
> apps' dev servers", "build passes 6/6 (5 apps + the SDK)") describe
> Phase 8, when there were five apps. The repo now has six apps
> (admin arrived on `feature/admin-control-plane`) — the counts above
> are historical, not current.

## What moved

- `app/` (landing, terms, robots, sitemap, layout, globals.css) →
  `apps/marketing` (`@sendcms/marketing`, dev port 3000 — keeps the root
  app's port, it is the public site). `components/product-schema.tsx` +
  `components/theme-toggle.tsx`, `lib/utils.ts` (getBaseUrl),
  `content/homepage.md` + `content/terms.md`, `styles/`,
  `config/config.json`, and the brand `public/` assets moved with it.
  The root `app/`, `lib/`, `components/`, `content/`, `styles/`,
  `config/`, `public/`, and `next.config.mjs` are gone — the root is now
  a pure workspace root (see below).
- `app/changelog/` + `content/changelog.md` → `apps/updates`
  (`@sendcms/updates`, dev port 3004).
- The user docs (`docs/*.md`) are served by a new `apps/docs`
  (`@sendcms/docs`, dev port 3003): an index page listing the 11 user
  docs + a `[slug]` page rendering each one. The docs app reads the
  repo's `docs/` dir directly (see below), so the GitHub docs stay the
  single source of truth. Repo docs (`architecture.md`, the
  transformation plan, the final report, `architecture/`, `archive/`)
  are NOT served.
- `lib/content.ts` + `lib/text-converter.ts` → `packages/content`
  (`@sendcms/content`): the markdown loader + converters are needed by
  all three public apps, so they became a shared package (the same
  pattern as `packages/email` in Phase 7). `getListPage` gained an
  optional `contentDir` parameter (default `<cwd>/content` — each app's
  own content/ dir); the docs app passes the repo's `docs/` dir.
  The package needs the `exports` + `main` + `types` fields pointing at
  `./src/index.ts` (like `@sendcms/shared`/`@sendcms/ui`) or TypeScript
  cannot resolve it — the first turbo typecheck failed on exactly this
  (TS2307 in the updates app).
- Each public app owns copies of `styles/`, `config/config.json`,
  `public/images/` + favicons (same as the dashboard app in Phase 7),
  its own `app/layout.tsx` (Geist fonts, ThemeProvider, Toaster), its
  own `lib/utils.ts` (getBaseUrl, reading its own `NEXT_PUBLIC_*_URL`
  var), and its own no-op `proxy.ts` (empty matcher — same pattern as
  `apps/api`, so a workspace-root proxy is never inherited).
- Each app has its own robots + sitemap (a sitemap lists only its own
  URLs): marketing lists `/` + `/terms`; updates lists `/changelog`;
  docs lists `/docs` + the 11 doc pages. The marketing sitemap DROPS
  `/changelog` (it lives on the updates app now) and its robots drops
  the `/dashboard`, `/sign-in`, `/api/` disallows (those live in
  sibling apps with their own robots files).

## Cross-app links (the public apps link to each other)

Each app runs as its own server (dev: a different localhost port;
production: its own public URL), so links that leave an app must be
absolute. New env vars (documented in `.env.example`):

- `NEXT_PUBLIC_API_URL` (dev http://localhost:3001) — the api app.
- `NEXT_PUBLIC_DASHBOARD_URL` (dev http://localhost:3002) — the
  dashboard app.
- `NEXT_PUBLIC_DOCS_URL` (dev http://localhost:3003) — the docs app.
- `NEXT_PUBLIC_UPDATES_URL` (dev http://localhost:3004) — the updates
  app.
- `NEXT_PUBLIC_APP_URL` (dev http://localhost:3000) — the marketing
  app (already existed; the sibling apps' "home" links use it).

`apps/marketing/lib/app-links.ts` resolves the content's app-agnostic
links (`/sign-in` → dashboard, `/changelog` → updates; `#…` anchors
and absolute URLs pass through) and exposes `apiUrl()` for the embed
snippet's script src. The landing page resolves the pricing plans'
CTA links once and passes the resolved plans to `ProductSchema`, so
the JSON-LD offer URLs match the rendered buttons. The updates +
docs apps have a one-line `marketingUrl()` helper for their home
links. The docs app's `[slug]` page 404s for unknown slugs
(`notFound()`); its title + description come from the doc's first H1

- first paragraph (the user docs have no frontmatter).

## The SDK serving origin (the deferred Phase 7 question) — resolved

The SDK posts to the script tag's own origin first
(`options.apiUrl` → script `src` origin → build-time `__APP_URL__`),
so the bundle is now served by the **api app**
(`apps/api/public/forms/v1.js` + `v1.debug.js` — the SDK build's
outfile moved there; the root's stale `public/forms/` build artifacts
are deleted). The script origin is then the api app's origin, which
is the submit API's origin — no SDK code change was needed.

- The dashboard's API page (`app/dashboard/api/page.tsx`) now reads
  `NEXT_PUBLIC_API_URL` (was `NEXT_PUBLIC_APP_URL`) for the snippet's
  script src + the REST examples.
- The landing page's example embed snippet reads `apiUrl()` (the api
  app) instead of `NEXT_PUBLIC_APP_URL`.
- The SDK build's `__APP_URL__` fallback reads `NEXT_PUBLIC_API_URL`
  → `NEXT_PUBLIC_APP_URL` (legacy) → `http://localhost:3001` (the api
  app's dev port).
- The `public/forms/**` eslint ignore moved from the root config to
  `apps/api/eslint.config.mjs` (the bundle lives there now). The
  bundle is gitignored by the unanchored `public/forms/` pattern in
  the root `.gitignore` (no change needed).

## The root is now a pure workspace root

- `dev` → `db:generate && sdk:build && turbo run dev` (all five apps'
  dev servers). `build` → `db:generate && sdk:build && turbo run build
--concurrency 1` (see below). `start` is removed (no root app to
  start). `build:cf` / `preview:cf` / `deploy:cf` are removed — the
  single-app Cloudflare deploy cannot serve five apps; Phase 10
  re-establishes the deploys per app. `wrangler.jsonc`,
  `open-next.config.ts`, and `cloudflare-env.d.ts` stay at the root
  untouched (Phase 10 retargets them); `cf-typegen` stays.
- The root `tsconfig.json` drops the `@/*` paths + the Next plugin +
  the `next-env.d.ts` / `.next/types` includes (the root has no app
  code — it typechecks only the tests + scripts). The root's
  `next.config.mjs`, `next-env.d.ts`, `.next/`, and
  `tsconfig.tsbuildinfo` are deleted. The root's `postcss.config.mjs`
  STAYS — PostCSS resolves it by walking up from each app's CSS, so
  all five apps share it (neither apps/api nor apps/dashboard has its
  own).
- Root dependencies: `github-slugger`, `gray-matter`, `marked` moved
  to `packages/content`; `lucide-react` + `next-themes` moved to the
  apps that use them. `next`, `react`, `react-dom` stay (the test
  suite imports `next/server`); `@react-email/render` + `nodemailer`
  stay (the auth-mailer + email-outbox tests import them directly).
- The root's eslint config now ignores the generated output
  workspace-wide (`**/.next/**`, `**/.open-next/**`,
  `**/public/forms/**`, `packages/database/generated/**`). The root
  `pnpm lint` traverses the apps/ + packages/ trees, and the
  root-anchored `.next/**` ignore did NOT match the apps' `.next/`
  dirs — the first Phase 8 lint run reported 412 errors / 13067
  warnings, all in generated files (the Prisma client, the minified
  SDK bundle, the apps' build output). The apps' own `eslint .`
  (turbo run lint) was clean throughout — the problem was only the
  root's traversal.

  > **Later change (2026-11-27):** "pure workspace root" above means
  > the root holds no app code — it does not mean the root is bare.
  > The root also carries workspace config, the repo-wide test suite
  > (`tests/`), the docs (`docs/`), and shared tooling such as
  > `postcss.config.mjs` and `render.yaml`.

## Parallel-build font contention (real failure, fixed)

`pnpm build` (turbo, parallel) failed twice on `next/font/google`
(Geist): once with "Failed to fetch Geist from Google Fonts" (docs +
updates), once with "Module not found: Can't resolve
'@vercel/turbopack-next/internal/font/google/font'" (marketing).
Each app builds cleanly ALONE (verified one by one: marketing,
docs, updates, dashboard all exit 0 sequentially). The five apps'
parallel builds contend on the font fetch / Turbopack font loader.
Fix: the root `build` script runs `turbo run build --concurrency 1`
(sequential, keeps turbo's caching + pipeline). The full build then
passes 6/6 (5 apps + the SDK). The `dev` script stays parallel —
dev servers are long-running and fetch fonts lazily on first request.

## Latent bug fixed along the way (not Phase 8 scope, but real)

`apps/dashboard/lib/callback-url.ts` (`dashboardCallbackURL()`) read
`window.location.origin` unconditionally. `SocialSignInButtons` (a
client component) calls it as a default prop value, which is
evaluated during the SERVER-side render too — so `/sign-in` (and
`/sign-up`) 500'd with `ReferenceError: window is not defined`. The
Phase 7 journey never fetched the auth pages (it signed in via the
API), so the bug was latent since Phase 7. Fixed here:
`dashboardCallbackURL()` now guards `typeof window === "undefined"`
and falls back to `NEXT_PUBLIC_DASHBOARD_URL` (dev default
http://localhost:3002) — which matches the page's origin, so SSR and
the client render the same URL (no hydration mismatch). The
dashboard dev server now gets `NEXT_PUBLIC_DASHBOARD_URL` in its env.
Verified live: `/sign-in` + `/sign-up` return 200.

## Verification (2026-11-18)

- Root typecheck clean; `turbo run typecheck` **21/21** (17 + content
  - marketing + docs + updates). First run was 20/21 (the missing
    `exports`/`main`/`types` fields in `@sendcms/content` — fixed above).
- Root lint 0 errors / 1 pre-existing warning (the
  `window.location.href` warning in `apps/dashboard/app/dashboard/error.tsx`).
  `turbo run lint` 5/5.
- Tests **202/202 (19 files)**. First run was 193/202 — `tests/sdk.test.ts`
  read the bundle from the old `public/forms/v1.js` (deleted); updated
  to `apps/api/public/forms/v1.js` + `pnpm sdk:build` regenerates it
  there (v1.js 7449 bytes, same as the Phase 6 bundle — the bundle
  content is unchanged, only the output path moved).
- Builds: `pnpm build` exit 0, **6/6** (5 apps + SDK) — after the
  `--concurrency 1` fix (see above).
- Live journey **61/61, exit 0, first run** (script
  `~/workspace/scripts/phase8-journey.mjs`; output
  `~/workspace/journey-phase8.log`): the 44 Phase 7 checks + 17 new
  ones. The new checks verify: the SDK bundle serves 200 from the api
  app AND 404s on the marketing app; the landing's embed snippet
  points at the api app; its sign-in links point at the dashboard app;
  its changelog link points at the updates app; the changelog's home
  link points at the marketing app; all three public apps' sitemaps +
  robots serve; the docs index lists the docs, `/docs/sdk` renders,
  an unknown slug 404s. Owner accounts intact (4). The five dev
  servers ran on ports 3000–3004 with the cross-app env vars from
  `.env.example`.
- The `pnpm build` log is at `~/workspace/phase8-build.log`.

## Deferred / Phase 10

- Per-app production URLs (the `FALLBACK_APP_URL` in each public
  app's `lib/utils.ts` is still the shared `https://jadoo.bond`
  placeholder) + per-app Cloudflare deploys (the root's `build:cf`
  was removed here).
- The docs app's `[slug]` page renders the markdown with
  `markdownify` (inline HTML) + a hand-rolled prose class list — a
  proper markdown component (e.g. `@tailwindcss/typography`) is a
  Phase 10+ polish item, not a Phase 8 gate.
