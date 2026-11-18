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
pnpm dev              # prisma generate + SDK build + next dev (turbopack)
pnpm build            # prisma generate + SDK build + next build
pnpm start            # production next start
pnpm typecheck        # tsc --noEmit (run before declaring work done)
pnpm lint             # eslint
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
pnpm sdk:build        # minified → public/forms/v1.js (+ debug → public/forms/v1.debug.js)
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

- Admin routes gated by `proxy.ts` (Next middleware — named `proxy.ts`, not `middleware.ts`; matcher: `/dashboard/:path*`). Session lookup hits Prisma, so the proxy runs on the Node.js runtime — it is NOT edge-safe. Config: `packages/auth/src/auth.ts` (`createSendcmsAuth`, with Prisma adapter), wired by the thin `lib/auth.ts` wrapper (injects the app mailer). Verification: email/password sign-in is refused while the email is unverified; OAuth trust varies by provider (Google: profile `email_verified`; GitHub: `/user/emails` verified flag; Facebook: none — those users get a verification email on sign-up). Verification gates domain registration / submissions (Phase 3/5), not dashboard access. Auth mail (verification + reset) goes through the shared email provider (`lib/email/provider.ts` — Resend when `RESEND_API_KEY` is set, SMTP fallback); without a provider, dev logs the links to the server console and production fails loudly. First user becomes PLATFORM_OWNER via an atomic conditional UPDATE + partial unique index (`User_single_platform_owner_idx`).

### Layered request flow — HARD RULE (`coding-conventions.md`)

```
app/api/**          route handler  — thin: parse, auth, call service, respond (≤25 lines)
  ↓
lib/services/**     business logic — NO Next.js imports (must be framework-agnostic)
  ↓
@sendcms/database   Prisma singleton (`db`) — ONLY services may import this
  ↓
PostgreSQL (Prisma adapter-pg)
```

- Route handlers never import `@sendcms/database` — they call services.
- Zod schemas: `lib/validators/`, shared by routes + services.
- Response/error helpers: `lib/api/`.

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

- `proxy.ts` (root) — the Next middleware, renamed from `middleware.ts`.
- `packages/database/generated/prisma/` — Prisma client output. Import from `@sendcms/database`. Do not edit.
- `packages/database/prisma.config.ts` — Prisma schema/migrations config.
- `config/config.json` — feature flags + app config. All new config goes here, not `.env` or hardcoded.

### Form SDK specifics (`sdk/`)

- Dependency-free vanilla TS, built by esbuild to `public/forms/v1.js`
  (~7 KB minified). Config resolves form data attrs > `init()` options >
  script tag data attrs; API origin resolves script `src` origin >
  build-time `__APP_URL__`.
- Auto-enhances `<form data-cms-form>`; `MutationObserver` + `astro:page-load`
  cover SPA navigation and Astro transitions. Never read `process.env` in
  SDK source — compile-time defines only.
- jsdom tests load the built bundle with `window.eval(bundle)` (a
  `<script>` element appended to jsdom runs in its own vm context, so
  `window.SendCMS` and mocked `fetch` would not be shared).

## Environment

Required env (see `.env.example`): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `CRON_SECRET`. Optional: `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` (OAuth providers are offered only when their credentials are set), `SMTP_*` (fallback when no Resend key), `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

Google Cloud Console — authorized redirect URIs must include:

- `<APP_URL>/api/auth/callback/google` (admin Better Auth)

<!-- BEGIN:project-guidelines-rules -->

# Read project guidelines before changing structure, schema, components, or routes

Before modifying or creating database schemas, coding patterns, UI components, folder structure, or routes, trigger the `project-guidelines` skill for the relevant reference so you follow project conventions (DB rules, coding style, component usage, auth patterns, route templates).

<!-- END:project-guidelines-rules -->
