Guidance for agentic tools working in this repo.

> **Detailed conventions: `project-guidelines` skill** (`.agents/skills/project-guidelines/`).
> Invoke it before changing schema, routes, UI, services, folder structure, or auth — or writing a commit.
> This file is the always-loaded map; the skill is the rulebook. Don't duplicate its details here.

## Project

SendCMS — contact-form backend for any website (Astro, Next.js, Hugo,
WordPress, plain HTML). Next.js 16 (App Router) server + vanilla-TS form
SDK + PostgreSQL via Prisma. Owners register domains, create forms, and
embed one script tag; submissions land in a dashboard inbox with spam
filtering and email notifications.

The repo started as OpenRemark (a comment system) and was rebuilt into
SendCMS on branch `feat/contact-form-saas` (see
`docs/sendcms-transformation-plan.md`, 11 phases). The legacy comment
system (`Site`/`Page`/`Comment` models, `/api/widget/*`,
`/api/v1/sites/*`, `widget/`) was removed entirely on 2026-11-18
(owner-approved) — nothing of it remains.

Beta: APIs and schema may change without migration paths.

## Commands

Package manager: **pnpm** (v12).

```bash
pnpm dev              # prisma generate + SDK build + turbo dev (all 5 apps, ports 3000–3004, + the email worker on 3005)
pnpm build            # prisma generate + SDK build + turbo build --concurrency 1 (sequential — parallel builds contend on next/font, see ADR 0006)
pnpm typecheck        # tsc --noEmit (run before declaring work done)
pnpm lint             # eslint (root config ignores generated output workspace-wide)
pnpm test             # vitest run (tests/ — services, validators, SDK)
pnpm test:watch       # vitest watch mode
pnpm format           # prettier --write "**/*.{ts,tsx}"
pnpm format:check     # prettier --check

# Database (PostgreSQL, Prisma)
pnpm db:migrate       # prisma migrate dev — create + apply
pnpm db:generate      # regenerate Prisma client (output: packages/database/generated/prisma)
pnpm db:seed          # tsx packages/database/prisma/seed.ts — SendCMS demo data (demo user, verified domain, form, sample submissions); idempotent, safe to re-run
pnpm db:studio        # Prisma Studio GUI
pnpm db:status        # scripts/db-manager.ts status
pnpm db:reset         # DESTRUCTIVE — requires typed confirmation

# Form SDK bundle (SendCMS)
pnpm sdk:build        # minified → apps/api/public/forms/v1.js (+ debug → apps/api/public/forms/v1.debug.js)
```

`pnpm dev` regenerates the Prisma client and rebuilds the SDK bundle every start — don't skip it. The bundle is gitignored; CI builds it before testing.

## Architecture

Detailed rules per section: `project-guidelines` skill (reference file in parentheses).

### Auth (`auth-system.md`)

One auth system: owners sign in with Better Auth 1.7.x — Google/GitHub/
Facebook OAuth + email/password (verification required) → session cookie
(stored server-side in the database). Routes: `/dashboard`, `/api/v1/*`.
The legacy widget visitor auth (Google OAuth PKCE → signed Widget JWT,
`/api/widget/*`) was removed with the comment system.

- Admin routes gated by `apps/dashboard/proxy.ts` (Next middleware — named `proxy.ts`, not `middleware.ts`; matcher: `/dashboard/:path*`). Session lookup hits Prisma, so the proxy runs on the Node.js runtime — it is NOT edge-safe. Config: `packages/auth/src/auth.ts` (`createSendcmsAuth`, with Prisma adapter), wired by each app's thin `lib/auth.ts` wrapper (apps/api + apps/dashboard each own one — the apps run as separate servers and cannot share a Better Auth instance; the factory imports the platform mailer from `@sendcms/email` directly, Phase 9, no injection). Verification: email/password sign-in is refused while the email is unverified; OAuth trust varies by provider (Google: profile `email_verified`; GitHub: `/user/emails` verified flag; Facebook: none — those users get a verification email on sign-up). Verification gates domain registration / submissions (Phase 3/5), not dashboard access. Auth mail (verification + reset) goes through the shared email provider (`packages/email/src/provider.ts` — Resend when `RESEND_API_KEY` is set, SMTP fallback); without a provider, dev logs the links to the server console and production fails loudly. First user becomes PLATFORM_OWNER via an atomic conditional UPDATE + partial unique index (`User_single_platform_owner_idx`).

### Layered request flow — HARD RULE (`coding-conventions.md`)

```
apps/api/app/api/**  route handler  — thin: parse, auth, call service, respond (≤25 lines)
  ↓
packages/modules/** business logic — NO Next.js imports (must be framework-agnostic)
  ↓
@sendcms/database   Prisma singleton (`db`) — ONLY services may import this
  ↓
PostgreSQL (Prisma adapter-pg)
```

- Route handlers never import `@sendcms/database` — they call services.
- Zod schemas: `packages/modules/<name>/src/validators.ts`, shared by routes + services.
- Client hooks: `packages/modules/<name>/src/queries.ts` (React Query); `apiFetch` lives in `@sendcms/shared`.
- `ApiError` lives in `@sendcms/shared` (re-exported from `@sendcms/api-client`); `pingDatabase` lives in `@sendcms/database`.
- Response/error helpers: `@sendcms/api-client` (response.ts, error.ts, cors.ts).

### Data model (`database-schema.md`)

Contact forms (SendCMS — the live product):

```
User ──< Domain ──< DomainVerification
  │         │
  │         └──< FormDomain >── Form ──< FormField
  │                                  ├──< Submission ──< SubmissionEvent
  │                                  ├──< NotificationSettings
  │                                  └──< EmailJob (also ──< Submission)
  └──< AuditLog
```

- `Domain.domain` is `@unique` (normalized hostname); `Form.id` is the public `formId`.
- `Submission.data` is `Json` (fields vary per form); `originDomain` is the observed origin host.
- `EmailJob` is the notification outbox (`PENDING` → `SENT`/`FAILED`, with retries).
- `DomainVerification.challenge` is a 48-char random token, shared across the DNS TXT / meta-tag / file methods; 7-day TTL, 10 attempts.
- `Submission.status`: NEW | READ | STARRED | ARCHIVED | SPAM.

### Non-obvious gotchas (`folder-structure.md`)

- `apps/dashboard/proxy.ts` — the Next middleware (gates `/dashboard/:path*`), renamed from `middleware.ts`; the api, marketing, docs, and updates apps each have their own no-op `proxy.ts` (empty matcher) so they don't inherit the dashboard's.
- `apps/marketing`, `apps/docs`, `apps/updates` — the public apps (dev ports 3000, 3003, 3004). Cross-app links must be absolute (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DASHBOARD_URL`, `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_UPDATES_URL` — see `.env.example` and `apps/marketing/lib/app-links.ts`). Each public app has its own robots + sitemap listing only its own URLs.
- `packages/database/generated/prisma/` — Prisma client output. Import from `@sendcms/database`. Do not edit.
- `packages/database/prisma.config.ts` — Prisma schema/migrations config.
- `config/config.json` — feature flags + app config. All new config goes here, not `.env` or hardcoded.
- `pnpm build` runs the app builds SEQUENTIALLY (`turbo run build --concurrency 1`) — the five apps' parallel builds contend on `next/font/google` and fail intermittently (see ADR 0006). Do not remove the flag without re-verifying a full parallel build.

### Form SDK specifics (`packages/sdk/`)

- Dependency-free vanilla TS, built by esbuild to `apps/api/public/forms/v1.js`
  (~7 KB minified). Config resolves form data attrs > `init()` options >
  script tag data attrs; API origin resolves script `src` origin >
  build-time `__APP_URL__` (the api app's URL — the bundle is served by
  the api app, so the script origin IS the submit API's origin).
- Auto-enhances `<form data-cms-form>`; `MutationObserver` + `astro:page-load`
  cover SPA navigation and Astro transitions. Never read `process.env` in
  SDK source — compile-time defines only.
- jsdom tests load the built bundle with `window.eval(bundle)` (a
  `<script>` element appended to jsdom runs in its own vm context, so
  `window.SendCMS` and mocked `fetch` would not be shared).

## Environment

Required env (see `.env.example`): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `CRON_SECRET`. Optional: `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` (OAuth providers are offered only when their credentials are set), `SMTP_*` (fallback when no Resend key), `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `WORKER_PORT`/`WORKER_POLL_INTERVAL_MS` (standalone email worker, Phase 9).

Google Cloud Console — authorized redirect URIs must include:

- `<APP_URL>/api/auth/callback/google` (admin Better Auth)

<!-- BEGIN:project-guidelines-rules -->

# Read project guidelines before changing structure, schema, components, or routes

Before modifying or creating database schemas, coding patterns, UI components, folder structure, or routes, trigger the `project-guidelines` skill for the relevant reference so you follow project conventions (DB rules, coding style, component usage, auth patterns, route templates).

<!-- END:project-guidelines-rules -->
