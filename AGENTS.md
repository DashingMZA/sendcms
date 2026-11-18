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
models (`Site`/`Page`/`Comment`) and `/api/widget/*` still exist, but the
dashboard no longer exposes them — their removal is a separately
approved step. Do not build new features on the comment system.

Beta: APIs and schema may change without migration paths.

## Commands

Package manager: **pnpm** (v12).

```bash
pnpm dev              # prisma generate + widget build + SDK build + next dev (turbopack)
pnpm build            # prisma generate + widget build + SDK build + next build
pnpm start            # production next start
pnpm typecheck        # tsc --noEmit (run before declaring work done)
pnpm lint             # eslint
pnpm test             # vitest run (tests/ — services, validators, SDK)
pnpm test:watch       # vitest watch mode
pnpm format           # prettier --write "**/*.{ts,tsx}"
pnpm format:check     # prettier --check

# Database (PostgreSQL, Prisma)
pnpm db:migrate       # prisma migrate dev — create + apply
pnpm db:generate      # regenerate Prisma client (output: generated/prisma)
pnpm db:seed          # tsx prisma/seed.ts — SendCMS demo data (demo user, verified domain, form, sample submissions); idempotent, safe to re-run
pnpm db:studio        # Prisma Studio GUI
pnpm db:status        # scripts/db-manager.ts status
pnpm db:reset         # DESTRUCTIVE — requires typed confirmation
pnpm db:benchmark:seed
pnpm db:benchmark:run

# Widget bundle (legacy comment widget — still built, UI removed in Phase 9)
pnpm widget:build     # minified → public/embed.js (+ debug → public/embed.debug.js)
pnpm widget:dev       # non-minified, faster

# Form SDK bundle (SendCMS)
pnpm sdk:build        # minified → public/forms/v1.js (+ debug → public/forms/v1.debug.js)
```

`pnpm dev` regenerates Prisma client and rebuilds both bundles every start — don't skip it. Both bundles are gitignored; CI builds them before testing.

## Architecture

Detailed rules per section: `project-guidelines` skill (reference file in parentheses).

### Two auth systems, kept separate (`auth-system.md`)

| System | Who      | Mechanism                                  | Storage              | Routes                    |
| ------ | -------- | ------------------------------------------ | -------------------- | ------------------------- |
| Admin  | Owners   | Better Auth 1.7.x — Google/GitHub/Facebook OAuth + email/password (verification required) → session cookie | Server session (database) | `/dashboard`, `/api/v1/*` |
| Widget | Visitors | Google OAuth PKCE → signed Widget JWT      | `localStorage` (JWT) | `/api/widget/*`           |

- Admin routes gated by `proxy.ts` (Next middleware — named `proxy.ts`, not `middleware.ts`; matcher: `/dashboard/:path*`). Session lookup hits Prisma, so the proxy runs on the Node.js runtime — it is NOT edge-safe. Config: `lib/auth.ts` (full, with Prisma adapter). Verification: email/password sign-in is refused while the email is unverified; OAuth trust varies by provider (Google: profile `email_verified`; GitHub: `/user/emails` verified flag; Facebook: none — those users get a verification email on sign-up). Verification gates domain registration / submissions (Phase 3/5), not dashboard access. Auth mail (verification + reset) goes through the shared email provider (`lib/email/provider.ts` — Resend when `RESEND_API_KEY` is set, SMTP fallback); without a provider, dev logs the links to the server console and production fails loudly. First user becomes PLATFORM_OWNER via an atomic conditional UPDATE + partial unique index (`User_single_platform_owner_idx`).
- Widget: `Authorization: Bearer <jwt>` — no cookies (cross-origin). CSRF n/a; CORS allowlist enforced per `Site.allowedOrigins`.
- `WIDGET_JWT_SECRET` ≠ `BETTER_AUTH_SECRET` — do not conflate.

### Layered request flow — HARD RULE (`coding-conventions.md`)

```
app/api/**          route handler  — thin: parse, auth, call service, respond (≤25 lines)
  ↓
lib/services/**     business logic — NO Next.js imports (must be framework-agnostic)
  ↓
lib/db.ts           Prisma singleton — ONLY services may import this
  ↓
PostgreSQL (Prisma adapter-pg)
```

- Route handlers never import `lib/db.ts` — they call services.
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

Legacy comment models (schema + `/api/widget/*` + `/api/v1/sites/*`
still exist; dashboard UI removed in Phase 9):

```
User ──< Site ──< Page ──< Comment ──< Comment (replies, self-ref via @relation("Replies"))
                              │
                              └──< ModerationLog
```

- `Domain.domain` is `@unique` (normalized hostname); `Form.id` is the public `formId`.
- `Submission.data` is `Json` (fields vary per form); `originDomain` is the observed origin host.
- `EmailJob` is the notification outbox (`PENDING` → `SENT`/`FAILED`, with retries).
- `DomainVerification.challenge` is a 48-char random token, shared across the DNS TXT / meta-tag / file methods; 7-day TTL, 10 attempts.
- `Submission.status`: NEW | READ | STARRED | ARCHIVED | SPAM.
- `Comment.status`: PENDING | APPROVED | SPAM | DELETED. Soft delete only — never physically delete domain rows.
- `Site.siteKey` — public embed identifier. `Site.allowedOrigins` — JSON (Postgres native), enforced on widget POST.

### Non-obvious gotchas (`folder-structure.md`)

- `proxy.ts` (root) — the Next middleware, renamed from `middleware.ts`.
- `generated/prisma/` — Prisma client output. Import from `@/generated/prisma/client`. Do not edit.
- `prisma.config.ts` — Prisma schema/migrations config.
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

### Widget specifics (legacy comment widget)

- Shadow DOM — CSS isolated. Visuals: `widget/src/styles.css`.
- Compile-time constants via esbuild `define`: `__APP_URL__`, `__GOOGLE_CLIENT_ID__`, `__STYLES__`. **Never** read `process.env` in widget source.
- `widget/build.ts` loads `.env` then `.env.local` — widget needs `NEXT_PUBLIC_APP_URL` + `GOOGLE_CLIENT_ID` at build time.
- Auth flow (PKCE): popup → `accounts.google.com` (with `code_challenge`) → redirect to `/api/widget/oauth-callback` → `postMessage({type: "ZEON_GOOGLE_CODE", code, state})` to opener → `POST /api/widget/auth` exchanges `code` + `code_verifier` → server verifies with Google → issues 7-day Widget JWT.

## Environment

Required env (see `.env.example`): `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `WIDGET_JWT_SECRET`, `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `CRON_SECRET`. Optional: `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` (OAuth providers are offered only when their credentials are set), `SMTP_*` (fallback when no Resend key), `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

Google Cloud Console — authorized redirect URIs must include:

- `<APP_URL>/api/auth/callback/google` (admin Better Auth)
- `<APP_URL>/api/widget/oauth-callback` (widget visitor flow)

<!-- BEGIN:project-guidelines-rules -->

# Read project guidelines before changing structure, schema, components, or routes

Before modifying or creating database schemas, coding patterns, UI components, folder structure, or routes, trigger the `project-guidelines` skill for the relevant reference so you follow project conventions (DB rules, coding style, component usage, auth patterns, route templates).

<!-- END:project-guidelines-rules -->
