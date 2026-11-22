# SendCMS — Monorepo Migration Audit

**Date:** 2026-11-18
**Branch:** `feature/monorepo-architecture-migration` (from `main` @ `4fc2d17`)
**Main protected:** yes — `main` still points at `4fc2d17`, working tree was clean
when the branch was created, no user changes existed or were lost.
**Scope:** audit only. No restructuring has been done yet. This document is the
source of truth for the migration; do not assume the repo matches older docs.

📌 **Status note (2026-11-22):** this is a historical record of the audit
as written on 2026-11-18 — its claims, dates, SHAs, and counts are kept
as written. The migration it plans **is complete** (see
[migration-final-report.md](migration-final-report.md)). What changed
since: the production domain **is decided** (`sendcms.bond`; the
"undecided" items below are superseded), MCP and AI were built on
`feature/ai` (the "deferred entirely" items below are superseded — see
[../mcp.md](../mcp.md)), and the admin control plane (including
`apps/admin`) is in progress on `feature/admin-control-plane`.

## Contents

- [Owner decisions — 2026-11-18](#owner-decisions--2026-11-18)
- [1. Current architecture](#1-current-architecture)
- [2. Current feature inventory](#2-current-feature-inventory)
- [3. Existing dependency graph](#3-existing-dependency-graph)
- [4. Database and migration inventory](#4-database-and-migration-inventory)
- [5. Existing API compatibility requirements](#5-existing-api-compatibility-requirements)
- [6. Security observations](#6-security-observations)
- [7. Deployment observations](#7-deployment-observations)
- [8. Potential migration risks](#8-potential-migration-risks)
- [9. Proposed source-to-destination file mapping](#9-proposed-source-to-destination-file-mapping)
- [10. Migration sequence](#10-migration-sequence)

## Owner decisions — 2026-11-18

Recorded by the owner after reviewing this audit. They govern the rest of
the migration.

1. **Proceed** with the 13-phase sequence in §10.
2. **Apps naming: plain** — `apps/marketing`, `apps/docs`, `apps/api`,
   `apps/dashboard`, … (no domain suffixes; domains live in deployment
   config only).
3. **CI on this branch:** the owner adds `feature/**` to `ci.yml` via the
   GitHub web UI (the PAT cannot push workflow files). Until then, verification
   on this branch is local gates + PR-triggered CI.
4. **Production domain: undecided for now** (jadoo.bond vs openremark.bond).
   The migration proceeds without it; split apps' deployment configs will
   need it later. `FALLBACK_APP_URL` stays `https://jadoo.bond` until then.
5. **MCP/AI scope: deferred entirely.** No `packages/mcp` or `packages/ai`
   code in this migration. Their designs stay as documentation only
   (`docs/mcp/*`, `docs/ai/*` in Phase 13 if the owner wants them); Phases
   11–12 below are therefore documentation placeholders, not implementation
   phases.

---

## 1. Current architecture

Single-package Next.js application. One deployable unit serves everything:
the public landing page, auth pages, the customer dashboard, the public
submission API, the admin REST API, the email-outbox cron, and the form SDK
(build output only — the SDK source is vanilla TypeScript).

```
sendcms/                          # single pnpm package "sendcms" 0.1.0, private
├── app/                          # Next.js App Router (7,610 LOC)
│   ├── (auth)/                   # sign-in, sign-up, forgot/reset-password, verify-email
│   ├── (dashboard)/              # dashboard layout group
│   ├── dashboard/                # overview, domains, forms, inbox, notifications,
│   │                             # analytics, api, account
│   ├── api/                      # auth [...all], cron/email-outbox, health,
│   │                             # public/v1/submit, v1/domains, v1/forms,
│   │                             # v1/inbox, v1/email-jobs
│   ├── changelog/, terms/        # public content pages
│   ├── layout.tsx, page.tsx      # root layout + landing page
│   ├── sitemap.ts, robots.ts     # SEO routes (base URL from lib/utils.ts)
│   └── globals.css
├── lib/                          # 4,593 LOC — services, validators, queries,
│   │                             # email, permissions, cors, auth, db
├── components/                   # 3,459 LOC — dashboard components + shadcn/ui
├── sdk/                          # 819 LOC vanilla-TS SDK source → public/forms/v1.js
├── prisma/                       # schema.prisma (405 lines), 19 migrations, seed.ts
├── config/config.json            # site, metadata, branding, email defaults
├── content/                      # homepage.md, terms.md, changelog.md (editable)
├── docs/                         # user docs (markdown, GitHub-rendered, not served)
├── tests/                        # 19 files, 202 tests (Vitest, node env)
├── scripts/                      # db-manager.ts only
├── public/                       # images, favicon.ico, apple-touch-icon.png, _headers
├── proxy.ts                      # gates /dashboard/* via session lookup
├── wrangler.jsonc, open-next.config.ts   # Cloudflare Workers (OpenNext)
└── package.json                  # one package, 31 deps + 22 devDeps
```

**Layered flow (AGENTS.md hard rule, actually followed):** thin route
handlers (≤25 lines) → `lib/services/*` (no Next.js imports) → `lib/db.ts`
(Prisma singleton; only services import it — `lib/auth.ts` is the documented
exception). Verified: `lib/db.ts` is imported by the 8 services + `lib/auth.ts`
only. App routes import services, never `lib/db` directly.

**Tooling today:** pnpm 12.19.0, Node ≥24 (sandbox: v24.22.1), TypeScript 6.0.3,
ESLint 10 (flat config), Prettier, Vitest 5.1.0, Husky pre-commit
(`pnpm lint` + `format:check` + `typecheck`). No Turborepo. No workspace
packages.

**pnpm-workspace.yaml exists but defines no `packages:` globs** — it only
holds `allowBuilds` and `minimumReleaseAgeExclude`. The repo is effectively a
single-package workspace today.

**Import alias:** `@/*` → repo root (tsconfig + vitest alias). 194 TS/TSX
files use it. Any move must rewrite these imports.

---

## 2. Current feature inventory

What actually exists (verified against the repo, not the docs):

| Area                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                            | Better Auth 1.7.25: email/password + mandatory verification, Google/GitHub/Facebook OAuth (env-gated), password reset, change-email verifies the NEW address. First user → `PLATFORM_OWNER` (atomic conditional update + partial unique index). No MFA. No teams.                                                                                                                                                                                           |
| Domains                         | CRUD + ownership verification: DNS TXT (`sendcms._domainkey.<domain>`), meta tag, file at domain root. 48-char challenge, same across methods. 7-day TTL, 10 attempts. DoH (Cloudflare → Google) + SSRF guard.                                                                                                                                                                                                                                              |
| Forms                           | CRUD, 10 field types, 3 default fields, links to VERIFIED domains only (409 otherwise), per-form notification recipients, Turnstile toggle. `Form.id` is the public formId.                                                                                                                                                                                                                                                                                 |
| Submissions                     | `POST /api/public/v1/submit` (JSON + form-encoded + multipart). Origin allowlist (linked VERIFIED domain only), honeypot (fake 201), Turnstile fail-closed, spam heuristics (>3 links / repeated words → SPAM, no notification), DB rate limits (10/min + 100/hour per IP, per-form dailyLimit), idempotency keys + 10-min content-hash dedupe, 64 KB cap, durable save in `$transaction` BEFORE success. 201 created / 200 duplicate / 303 no-JS redirect. |
| Inbox                           | Tabs (all/unread/read/starred/archived/spam), search incl. inside JSON data, form/domain/date filters, detail + event timeline, status + bulk actions, hard delete. All queries scope through `form.ownerId`.                                                                                                                                                                                                                                               |
| Notifications                   | Resend (REST) → platform SMTP → none. `EmailJob` outbox, retries 1m/5m/15m/1h/4h (5 attempts); retriable failures stay PENDING, FAILED is terminal only. Enqueue awaited in submit; immediate delivery via `after()`; cron `GET /api/cron/email-outbox` (Bearer `CRON_SECRET`). SPAM gets no notification.                                                                                                                                                  |
| Dashboard                       | Overview (stats + 14-day chart + recent submissions), Analytics (30-day), API & SDK page (public userId, SDK snippet, REST reference, "no API keys").                                                                                                                                                                                                                                                                                                       |
| SDK                             | Vanilla-TS, esbuild → `public/forms/v1.js` (7.1 KB). `<script data-user-id data-form-id>` + `<form data-cms-form>` auto-enhance, `window.SendCMS.submit`, invisible Turnstile lazy-loaded, no-JS 303 fallback. Tested with jsdom + the real built bundle. Never verified inside a real browser.                                                                                                                                                             |
| Marketing                       | Single landing page (`app/page.tsx` + `content/homepage.md`). No blog, no pricing page beyond the Free $0 plan section, no SEO/GEO pages.                                                                                                                                                                                                                                                                                                                   |
| Updates                         | Single changelog page (`app/changelog` + `content/changelog.md`, SendCMS 0.1.0 launch entry).                                                                                                                                                                                                                                                                                                                                                               |
| Docs                            | Markdown in `docs/` (getting-started, REST API, SDK, security, deployment, troubleshooting, embed guides for Astro/Next.js/Hugo/HTML). Not served as an app.                                                                                                                                                                                                                                                                                                |
| Admin                           | No separate admin app. Platform-owner concept exists (`PLATFORM_OWNER` role); admin capabilities are: dashboard account/administration remnants removed in the 2026-11-18 comment-system removal. No users/teams/plans/abuse/queue-monitoring UI.                                                                                                                                                                                                           |
| API keys                        | Do NOT exist. The API & SDK page states "no API keys" — auth is session-based; the public submit API is Origin-allowlisted, not keyed.                                                                                                                                                                                                                                                                                                                      |
| Webhooks                        | Do NOT exist (no models, routes, or signing code).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Billing / subscriptions / usage | Do NOT exist (no models, no Stripe/Paddle integration).                                                                                                                                                                                                                                                                                                                                                                                                     |
| Teams / contacts                | Do NOT exist (removed with the comment system 2026-11-18).                                                                                                                                                                                                                                                                                                                                                                                                  |
| MCP                             | Does NOT exist.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AI                              | Does NOT exist (no providers, no agents, no tools).                                                                                                                                                                                                                                                                                                                                                                                                         |
| Workers                         | Do NOT exist as separate services. Background work is: `after()` in the submit route + the email-outbox cron endpoint. No Redis, no queue infra, no scheduler beyond the cron HTTP endpoint.                                                                                                                                                                                                                                                                |

**What the brief's target structure assumes but the repo does not have:**
API keys, webhooks, billing, subscriptions, usage metering, teams, contacts,
admin app, MCP, AI, support/status apps. These are new capabilities, not
migrations. They must be built (or explicitly deferred), not "moved".

---

## 3. Existing dependency graph

**Runtime (31):** next 16.4.6, react 19.3.1, react-dom 19.3.1,
better-auth 1.7.25 (exact pin), prisma 7.10.1 + @prisma/client 7.10.1 +
@prisma/adapter-pg 7.10.1, pg 8.23.1, zod 4.6.7, @tanstack/react-query 5.108.0,
nodemailer 10.6.0, react-email 6.11.15 + @react-email/render 2.3.1,
tailwindcss 4.3.5 (+ @tailwindcss/postcss), radix-ui 1.8.1, lucide-react 1.74.0,
@remixicon/react 4.9.0, recharts 3.11.0, sonner 2.0.8, next-themes 0.4.6,
class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.7.0,
date-fns 4.4.0, dotenv 18.0.10, github-slugger 2.0.0, gray-matter 4.0.3,
marked 18.2.1, jose 6.2.17, @next/third-parties 16.4.6.

**Dev (22):** typescript 6.0.3 (NOT 7 — typescript-eslint 8.x hard-crashes on
TS 7; stay on 6.x until typescript-eslint supports TS 7.1+ stable), eslint
10.15.0 + eslint-config-next 16.4.6, prettier 3.10.1 (+ tailwind plugin),
vitest 5.1.0 + jsdom 31.0.1, esbuild 0.28.2, wrangler 4.164.0,
@opennextjs/cloudflare 1.20.17, husky 9.1.7, tsx 4.23.15, lightningcss 1.33.0,
postcss 8.5.33, @types/* (node, pg, nodemailer, react, react-dom,
dotenv-defaults), @eslint/eslintrc 3.3.7, @tailwindcss/postcss 4.3.5.

**Internal dependency flow (verified by grep):**

```
app/api/*, app/dashboard/*, app/(auth)/*
  └─► lib/services/*  (form-service ×16 imports, domain-service ×9,
  │    submission-service ×8, email-outbox ×5, dashboard-service ×2,
  │    user-service ×1, system-service ×1)
  │    └─► lib/db.ts (Prisma) ─► generated/prisma
  │    └─► lib/validators/* (Zod), lib/email/*, lib/cors.ts, lib/permissions/*
  └─► lib/auth.ts (Better Auth + auth() helper)
  └─► lib/queries/* (React Query hooks, client components)
  └─► components/* (dashboard + ui + logo)
  └─► config/config.json, content/* (via lib/content.ts)
sdk/src/* ─► (standalone; esbuild bundle; NO server imports)
  └─► public/forms/v1.js (built artifact, gitignored)
```

**Coupling hotspots for the move:**

- `lib/auth.ts` is imported by auth pages, dashboard layout, the auth route,
  and one v1 route. It imports `lib/db.ts` (the documented exception).
- `proxy.ts` gates `/dashboard/*` via session lookup; it lives at the repo
  root because Next.js requires it there (or `src/proxy.ts`). Each split app
  will need its own proxy/middleware decision.
- `config/config.json` is imported by layout, logo, product-schema, and the
  landing page. It holds site/favicon/logo paths, metadata, email defaults.
- `lib/content.ts` + `content/*.md` + `lib/text-converter.ts` power the
  landing/changelog/terms pages — these move with the marketing/updates apps.
- `lib/sdk-snippet.ts` builds the embed snippet shown on the dashboard API
  page and form pages; it must agree with the SDK's public contract.
- `generated/prisma/` (gitignored Prisma client output) is imported as
  `@/generated/prisma` everywhere via `lib/db.ts`. Moving Prisma into
  `packages/database` changes the client import path and the generate output
  path; `prisma.config.ts` paths (`schema`, `migrations`, `datasource.url`)
  must move with it.
- `public/forms/v1.js` is referenced by docs, the dashboard snippet, and the
  SDK tests. If the SDK becomes `packages/sdk`, the built bundle must still
  land where the serving app expects it (or be served from the SDK package
  with a documented URL).

---

## 4. Database and migration inventory

- **Engine:** PostgreSQL (user's dev Prisma Postgres at db.prisma.io; the URL
  is a secret — never written to files, memory, or logs).
- **Prisma:** 7.10.1. `prisma.config.ts` at root; schema `prisma/schema.prisma`
  (405 lines); `DATABASE_URL` must use `?sslmode=verify-full` (Prisma 7 +
  db.prisma.io; `uselibpqcompat=true` breaks Studio, bare `sslmode=require`
  is wrong).
- **Models (14):** User, Account, Session, Verification (Better Auth shapes)
  - Domain, DomainVerification, Form, FormDomain, FormField, Submission,
    SubmissionEvent, NotificationSettings, EmailJob, AuditLog.
- **Enums (11):** PlatformRole, DomainStatus, DomainVerificationMethod,
  DomainVerificationStatus, FormFieldType, SubmissionStatus,
  SubmissionEventType, EmailJobType, EmailJobStatus, AuditAction,
  AuditResource.
- **Migrations (19, all in `prisma/migrations/`):** 15 legacy comment-era
  migrations (2026-04 → 2026-08, incl. the RBAC and comment-widget ones) +
  4 SendCMS-era: `20261117185033_add_contact_form_models`,
  `20261117190655_single_platform_owner`,
  `20261117224500_switch_auth_to_better_auth`,
  `20261118084500_remove_comment_system` (drops the 9 legacy tables + 3 enums;
  applied to the dev DB — all 9 tables held 0 rows).
- **Dev DB state (2026-11-18):** 19/19 migrations applied; 4 owner accounts
  (all verified; admin@csofts.com = PLATFORM_OWNER); domains jadoo.bond
  (VERIFIED, old TXT name) + jadoo.cyou (PENDING, FILE method); 1 form; 0
  submissions; 0 email jobs.
- **Seed:** `prisma/seed.ts` (SendCMS-only; demo user, VERIFIED domain +
  DNS_TXT record, form `demo-form-001`, 3 default fields, link, notification,
  3 sample submissions incl. 1 SPAM; idempotent).
- **Rules for this migration:** never rewrite/delete historical migrations;
  never reset a database; schema changes (if any) are forward-only with a
  documented rollback. The migration itself should need NO schema change —
  moving the Prisma files into `packages/database` is a file move, not a
  schema change. Verify `prisma migrate deploy` still resolves the moved
  paths before any commit that moves them.

---

## 5. Existing API compatibility requirements

Must not change without a documented, tested compatibility plan:

| Surface                                                                                            | Contract                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/public/v1/submit`                                                                       | JSON + form-encoded + multipart. 201 created / 200 duplicate / 303 no-JS redirect (`?cms_submitted=1` / `?cms_error=`). Honeypot field `_sendcms_honeypot`. Response shape + status codes are the SDK's and the docs' contract. Origin allowlist enforced; rejected origins get NO CORS echo. |
| `GET /api/public/v1/submit` (and other methods)                                                    | Not a public endpoint; do not invent one.                                                                                                                                                                                                                                                     |
| `POST /api/cron/email-outbox`                                                                      | Bearer `CRON_SECRET`. Processes the EmailJob outbox.                                                                                                                                                                                                                                          |
| `GET /api/health`                                                                                  | DB health ping.                                                                                                                                                                                                                                                                               |
| `GET/POST/PATCH/DELETE /api/v1/domains/*`                                                          | Session-gated admin REST (Better Auth session). Domain CRUD + verify/reverify.                                                                                                                                                                                                                |
| `GET/POST/PATCH/DELETE /api/v1/forms/*` (+ `/fields`, `/domains`, `/notifications`, `/test-email`) | Session-gated admin REST.                                                                                                                                                                                                                                                                     |
| `GET/PATCH/DELETE /api/v1/inbox/*` (+ `/bulk`)                                                     | Session-gated admin REST.                                                                                                                                                                                                                                                                     |
| `GET /api/v1/email-jobs`                                                                           | Session-gated admin REST (delivery log).                                                                                                                                                                                                                                                      |
| `GET /api/auth/[...all]`                                                                           | Better Auth handler (email verification links point at API endpoints directly: `/api/auth/verify-email?token=…&callbackURL=…`).                                                                                                                                                               |
| SDK `window.SendCMS`                                                                               | `init({userId, formId, …})`, `submit(form, data?)`, `data-user-id` / `data-form-id` attrs (form attrs win), `data-cms-form` auto-enhance, Turnstile `turnstileSiteKey`. Bundle URL `…/forms/v1.js` (7.1 KB).                                                                                  |
| Auth cookies/session                                                                               | Better Auth session cookie; `proxy.ts` gates `/dashboard/*`.                                                                                                                                                                                                                                  |
| Sitemap/robots                                                                                     | `getBaseUrl()` → `NEXT_PUBLIC_APP_URL` ?? `https://jadoo.bond` (fallback changed 2026-11-18; production domain still undecided).                                                                                                                                                              |

**Compatibility test assets that must keep passing:** `tests/submit-route.test.ts`,
`tests/submission-service.test.ts`, `tests/submission-validation.test.ts`,
`tests/submission-form-data.test.ts`, `tests/inbox.test.ts`,
`tests/domain-service.test.ts`, `tests/form-service.test.ts`,
`tests/email-outbox*.test.ts`, `tests/sdk.test.ts` (loads the real built bundle),
`tests/turnstile.test.ts`, `tests/permissions.test.ts`, `tests/dashboard.test.ts`,
`tests/dns-verification.test.ts`, `tests/auth-*.test.ts`, `tests/domain-normalize.test.ts`,
`tests/form-validators.test.ts`. Baseline: **202/202 pass** (verified 2026-11-18).

---

## 6. Security observations

What exists today (verified):

- **Auth:** Better Auth 1.7.25, mandatory email verification
  (`requireEmailVerification: true`; unverified sign-in → 403
  `EMAIL_NOT_VERIFIED`), OAuth env-gated, Facebook users land unverified by
  design (Facebook sends no `email_verified`). First-user PLATFORM_OWNER race
  fixed atomically. No MFA.
- **Authorization:** `lib/permissions/platform.ts` (`platformCan`) gates
  dashboard nav; every inbox query scopes through `form.ownerId`; forms link
  to VERIFIED domains only; `emailVerified` gate (403) on domain creation.
  No resource-level policy framework beyond this; no team isolation (no teams).
- **Public submit:** Origin allowlist (no CORS echo for rejected origins),
  honeypot fake-201, Turnstile fail-closed (503 no secret / 422 no token /
  403 failed verify), rate limits, idempotency + dedupe, 64 KB payload cap,
  Zod validation, spam heuristics. Origin/Referer are treated as
  authorization-adjacent only for the allowlist, never as authentication.
- **Secrets:** Resend key is stored in the connector and cannot be read back;
  app `RESEND_API_KEY` must be set separately in deployment env. No secrets
  in code (audited 2026-11-17; zero secrets/IDs/emails found). `.env.example`
  holds placeholders only. `BETTER_AUTH_SECRET` is env-only.
- **Headers:** `public/_headers` sets nosniff / referrer / frame / permissions
  policies. **No CSP on purpose** — Next.js inlines scripts/styles, so a CSP
  would need `unsafe-inline` (documented in the file).
- **Email:** verification/reset links go through the auth mailer; submission
  notifications go through the outbox (no direct user-controlled mail send).
- **Audit:** `AuditLog` model + `AuditAction`/`AuditResource` enums exist;
  domain/form actions log. No admin UI reads them.
- **Known gaps (do not overstate):** no API keys (so no key hashing/scoping
  yet), no webhooks (so no HMAC/replay handling yet), no rate limiting on the
  admin REST API beyond the public submit limits, no CSP, no dependency
  scanning / secret scanning / SAST in CI (CI runs install → generate →
  sdk:build → typecheck → lint → test → build only), no MFA, no DAST.
- **CI security note:** the stored PAT has NO `workflow` scope — workflow
  files (`.github/workflows/*`) cannot be pushed via the Git Data API; they
  go through the owner's GitHub web UI. CI config changes need the owner.
- **CI trigger gap (found in this audit):** `ci.yml` triggers on push to
  `main` and `feat/**` plus pull requests. This branch is
  `feature/monorepo-architecture-migration`, so **pushes to it will NOT run
  CI**; CI will run when a PR is opened from it. If push-triggered CI is
  wanted on this branch, the owner must add `feature/**` to `ci.yml` via the
  web UI (or the branch must be renamed to `feat/…` — the brief fixes the
  name, so the web-UI edit is the route). Recorded as a decision item, not
  changed here.

---

## 7. Deployment observations

- **Vercel (manual-only, user directive 2026-10-05):** auto-deploy on git push
  is DISABLED via Ignored Build Step ("Don't build anything"). GitHub Actions
  CI runs only on pull_request and workflow_dispatch, not on push to main in
  the Vercel sense — pushing to main triggers nothing; deploys are manual via
  dashboard or agent when tested and ready. Do not change this.
- **Cloudflare Workers (current deploy target):** OpenNext adapter,
  `wrangler.jsonc` — worker name `sendcms`, `main: .open-next/worker.js`,
  assets `.open-next/assets`, R2 bucket `open-remark-opennext-cache` (real
  Cloudflare resource — legacy name; renaming needs a new bucket in the
  dashboard), self-reference service `sendcms`, vars
  `NEXT_PUBLIC_APP_URL: https://jadoo.bond` (owner decision 2026-11-13:
  jadoo.bond is for Cloudflare ONLY). `build:cf` chain:
  `prisma generate && sdk:build && opennextjs-cloudflare build`. Next
  `wrangler deploy` creates a NEW `sendcms` worker — the old `open-remark`
  worker must be deleted in the dashboard once live. Secrets live in the
  dashboard, never in the repo.
- **Production domain undecided:** `jadoo.bond` (Cloudflare) vs
  `openremark.bond` (Vercel). The SDK URL, canonical URLs, and the
  `FALLBACK_APP_URL` in `lib/utils.ts` all follow from this decision. Do not
  hardcode a new production URL anywhere in this migration.
- **No production deployment during this task** (brief §15/§19). No
  production DB was touched; the dev DB is the only database ever used from
  this environment.
- **OpenNext constraint:** the Cloudflare build expects a single Next.js app
  at the repo root (`open-next.config.ts`, `.open-next/` output). Splitting
  into `apps/*` changes what `build:cf` builds and where `wrangler.jsonc`
  points. The migration must keep one working Cloudflare build at every
  step, or explicitly document the cutover step.
- **Build outputs in the worktree (gitignored):** `.next/`, `.open-next/`,
  `node_modules/`, `generated/`, `public/forms/v1.js`, `tsconfig.tsbuildinfo`.
  The sandbox `/tmp` is a 512M tmpfs — never put worktrees/clones there.

---

## 8. Potential migration risks

| #   | Risk                                                                                               | Severity | Mitigation                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@/` alias + 194 files of imports break on move                                                    | High     | Move in small batches; after each batch run typecheck + tests; use codemod-style `sed` on import paths, verified by `tsc --noEmit`.                                                                                                                                                         |
| 2   | Prisma client path (`generated/prisma`, `prisma.config.ts`) breaks                                 | High     | Move schema + migrations + config together into `packages/database`; keep `prisma generate` output path working; verify `prisma migrate deploy` resolves before committing the move. No schema change in the move.                                                                          |
| 3   | Better Auth route + `proxy.ts` placement                                                           | High     | Auth handler + proxy must live in the app that serves auth/dashboard. Do not split auth across apps until the session/cookie domain story is decided.                                                                                                                                       |
| 4   | Cloudflare OpenNext single-app assumption                                                          | High     | Keep one Next app as the deployable unit until the split is proven; `build:cf` + `wrangler.jsonc` must be updated in the same commit as any app move.                                                                                                                                       |
| 5   | SDK bundle URL contract (`/forms/v1.js`)                                                           | Medium   | Keep the built bundle served from the same path; SDK tests load the real bundle — they fail loudly if the path breaks.                                                                                                                                                                      |
| 6   | Turborepo version + pnpm 12 workspace semantics                                                    | Medium   | Verify latest stable Turbo from npmjs at implementation time (no beta); `pnpm-workspace.yaml` needs a real `packages:` glob list; lockfile must be regenerated (`pnpm install --frozen-lockfile` in CI will fail on a stale lockfile).                                                      |
| 7   | CI does not run on `feature/**` pushes                                                             | Medium   | Verification on this branch relies on local gates + PR-triggered CI. Owner can add `feature/**` to `ci.yml` via web UI.                                                                                                                                                                     |
| 8   | Push tooling: the stored PAT has no `workflow` scope; the push script hardcodes `BRANCH='main'`    | Medium   | Feature-branch pushes need the script's `BRANCH` constant updated per branch (it creates the branch if missing — a stale value resurrects a deleted branch). Workflow files go via web UI only. Binary files (PNG/ICO) cannot go through the Git Data API push script — web UI upload only. |
| 9   | Dev DB is the user's live Prisma Postgres                                                          | Medium   | Never run `prisma migrate dev` / reset / seed against it casually; use `migrate deploy` only for forward migrations; keep the URL out of files/logs.                                                                                                                                        |
| 10  | Scope creep: brief assumes features that don't exist (API keys, webhooks, billing, teams, MCP, AI) | High     | Treat them as new capabilities with their own design + decision records. Do not fake them with empty packages or placeholder endpoints.                                                                                                                                                     |
| 11  | `apps/*` directory naming (`sendcms.com`, `docs.sendcms.com`, …)                                   | Low      | Directory names are not domains. Recommend plain names (`apps/marketing`, `apps/docs`, …) and keep domain mapping in deployment config only. Decision item.                                                                                                                                 |
| 12  | Splitting the dashboard from the API too early                                                     | High     | The dashboard and the API share auth/session, Prisma, and services. Split the packages first; split the apps only after the package boundaries are proven by a green build + tests.                                                                                                         |
| 13  | Husky + pnpm PATH                                                                                  | Low      | `export PATH="$HOME/.local/bin:$PATH"` before committing, or the pre-commit hook fails with `pnpm: not found`.                                                                                                                                                                              |

---

## 9. Proposed source-to-destination file mapping

Principles: move code in controlled batches; no file is rewritten, only
relocated + re-imported; no schema change; no API path change; no SDK
contract change. Packages are created only when they have a real
implementation to hold (brief §4).

| Source (today)                                                                                                                                                             | Destination (target)                                                           | Phase | Notes                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm-workspace.yaml` (add `packages:` globs)                                                                                                                              | same file, extended                                                            | 2     | `apps/*`, `packages/*`, `services/*`                                                                                     |
| — (new)                                                                                                                                                                    | `turbo.json`                                                                   | 2     | pipeline: build, typecheck, lint, test, dev (persistent), sdk:build                                                      |
| `package.json` (root)                                                                                                                                                      | same file, workspace scripts                                                   | 2     | root becomes workspace orchestrator; app scripts move to the app package                                                 |
| `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, `postcss.config.mjs`                                                                                                  | `packages/config/` (shared) + thin re-export shims at root/app                 | 3     | shared base configs; apps extend them                                                                                    |
| `prisma/schema.prisma`, `prisma/migrations/*`, `prisma.config.ts`, `prisma/seed.ts`, `lib/db.ts`, `generated/`                                                             | `packages/database/`                                                           | 4     | schema + migrations move together; no schema change; client import becomes `@sendcms/database`                           |
| `lib/auth.ts`, `lib/auth-client.ts`, `lib/auth-providers.ts`, `lib/permissions/*`                                                                                          | `packages/auth/` (+ `packages/permissions/` for the policy layer)              | 4     | Better Auth config; `proxy.ts` stays with the serving app                                                                |
| `lib/services/domain-service.ts`, `lib/validators/domain.ts`, `lib/queries/domains.ts`                                                                                     | `packages/modules/domains/`                                                    | 5     | + DNS verification (`lib/services/dns-verification.ts`)                                                                  |
| `lib/services/form-service.ts`, `lib/validators/form.ts`, `lib/queries/forms.ts`                                                                                           | `packages/modules/forms/`                                                      | 5     | + `lib/sdk-snippet.ts` (snippet builder)                                                                                 |
| `lib/services/submission-service.ts`, `lib/validators/submission.ts`, `lib/services/turnstile.ts`                                                                          | `packages/modules/submissions/`                                                | 5     | submit pipeline + spam/turnstile                                                                                         |
| `lib/services/email-outbox.ts`, `lib/email/*`, `lib/validators/email-jobs.ts`, `lib/queries/email-jobs.ts`                                                                 | `packages/email/` + `packages/modules/notifications/` (outbox state machine)   | 5/9   | provider + templates stay together; outbox logic is the notifications module                                             |
| `lib/services/dashboard-service.ts`, `lib/queries/inbox.ts`, `lib/validators/inbox.ts`, `lib/submission-display.ts`                                                        | `packages/modules/inbox/` (+ `packages/modules/analytics/` for the aggregates) | 5     | inbox reads + dashboard aggregates                                                                                       |
| `lib/services/user-service.ts`, `lib/validators/auth.ts`                                                                                                                   | `packages/modules/users/`                                                      | 5     | user lookup + auth methods                                                                                               |
| `lib/services/system-service.ts`, `app/api/health/route.ts`                                                                                                                | `packages/modules/` (health) / app health route                                | 5     | tiny; moves with the API app                                                                                             |
| `lib/api/*`, `lib/cors.ts`, `lib/utils.ts` (cn + getBaseUrl), `lib/api-client.ts`                                                                                          | `packages/shared/` (+ `packages/api-client/`)                                  | 3/6   | `getBaseUrl` fallback stays `https://jadoo.bond` until the domain decision                                               |
| `lib/content.ts`, `lib/text-converter.ts`, `content/*`                                                                                                                     | `apps/marketing/` (+ `apps/updates/` for changelog)                            | 8     | content moves with the apps that render it                                                                               |
| `sdk/*` (src, build.ts, docs.md, test-page.html, tsconfig.json)                                                                                                            | `packages/sdk/`                                                                | 6     | stays independently buildable; bundle still served at `/forms/v1.js` by the serving app                                  |
| `app/api/*` (all 21 routes)                                                                                                                                                | `apps/api/`                                                                    | 6/7   | thin handlers only; logic already lives in modules by then                                                               |
| `app/dashboard/*`, `app/(dashboard)/*`, `app/(auth)/*`, `proxy.ts`, `components/dashboard/*`, `components/logo.tsx`, `components/product-schema.tsx`, `components/theme-*` | `apps/dashboard/`                                                              | 7     | the customer app; auth pages move with it (session/cookie story)                                                         |
| `app/page.tsx`, `app/layout.tsx` (marketing parts), `content/homepage.md`                                                                                                  | `apps/marketing/`                                                              | 8     | landing page; shares `packages/ui` + `packages/config`                                                                   |
| `app/changelog/*`, `content/changelog.md`                                                                                                                                  | `apps/updates/`                                                                | 8     | changelog page                                                                                                           |
| `app/terms/*`, `content/terms.md`                                                                                                                                          | `apps/marketing/` (legal pages)                                                | 8     | or `apps/updates/`; decide with the owner — legal lives with marketing                                                   |
| `docs/*.md` (user docs)                                                                                                                                                    | `apps/docs/` (content) + `docs/` (repo docs stay)                              | 8     | docs app serves the existing markdown; repo `docs/architecture/*` etc. stay at root                                      |
| `components/ui/*`, `styles/*`                                                                                                                                              | `packages/ui/`                                                                 | 3     | shadcn/ui primitives + design tokens                                                                                     |
| `lib/email/templates/*`                                                                                                                                                    | `packages/email/templates/`                                                    | 9     | React Email templates with the provider                                                                                  |
| `app/api/cron/email-outbox/route.ts` + `lib/services/email-outbox.ts`                                                                                                      | `services/email-worker/` (entry point) + `packages/email/`                     | 9     | worker is a thin host over the existing outbox processor; the cron route stays as the trigger until a worker host exists |
| `tests/*` (19 files)                                                                                                                                                       | `tests/` (root, by area) + co-located `packages/*/tests/`                      | 13    | existing tests move with the code they cover; no test is deleted or weakened                                             |
| `AGENTS.md`, `CLAUDE.md`, `.agents/skills/project-guidelines/*`                                                                                                            | updated in place                                                               | 13    | monorepo rules, module boundaries, how to add apps/packages/modules/MCP/AI tools/workers                                 |
| `wrangler.jsonc`, `open-next.config.ts`, `public/_headers`                                                                                                                 | `infrastructure/cloudflare/` (config) + app-level copies as needed             | 10/15 | Cloudflare build must keep working at every step; cutover is explicit                                                    |
| `.github/workflows/ci.yml`                                                                                                                                                 | updated via owner web UI only                                                  | 14    | add `feature/**` trigger + turbo pipeline; PAT cannot push workflow files                                                |

**Explicitly NOT created as code in this migration (documented as planned):**
`packages/modules/{teams, contacts, webhooks, api-keys, billing, usage,
subscriptions, integrations, audit-logs, spam-protection, data-retention}`,
`packages/{ai, mcp, queue, cache, storage, search, support, automation,
workflows, security, encryption, secrets, observability, feature-flags,
localization, rate-limiter, event-bus}`, `apps/{admin, mcp, support, status}`,
`services/{webhook-worker, automation-worker, ai-worker, scheduled-jobs}`.
These have no implementation behind them today. Each gets a design note +
interface sketch in the relevant `docs/architecture/decisions/` record — not
empty directories with placeholder code. **MCP and AI are deferred entirely
per the owner's 2026-11-18 decision** — no `packages/mcp` or `packages/ai`
code in this migration; their designs stay as documentation only.

---

## 10. Migration sequence

Follows the brief's §18, adjusted for what the audit found (package split
before app split; MCP/AI as boundaries, not implementations; workers only
where a real workload exists).

| Phase                                 | Work                                                                                                                                                                           | Exit criteria                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Safety + audit                    | Branch protection (done), this audit, baseline gates recorded                                                                                                                  | This document committed on the feature branch; `main` untouched; baseline: typecheck clean, lint 0 errors / 1 warning, tests 202/202, `pnpm build` + `build:cf` green (verified 2026-11-18) |
| 2 — Workspace + Turborepo             | `pnpm-workspace.yaml` `packages:` globs, `turbo.json`, root scripts, lockfile regen                                                                                            | `pnpm install` clean; `turbo --version` works; existing app still builds from root                                                                                                          |
| 3 — Shared config + UI                | `packages/config` (ts/eslint/prettier/tailwind bases), `packages/shared`, `packages/ui`                                                                                        | App + SDK consume the shared configs; no behavior change; gates green                                                                                                                       |
| 4 — Database + auth                   | `packages/database`, `packages/auth`, `packages/permissions`                                                                                                                   | `prisma generate` + `migrate deploy` resolve from the new paths; auth flows verified by the existing journey; no schema change                                                              |
| 5 — Business modules                  | `packages/modules/{domains, forms, submissions, inbox, notifications, users, analytics}`                                                                                       | Services moved with their validators/queries; routes re-import; all 202 tests green                                                                                                         |
| 6 — SDK + API separation              | `packages/sdk`, `packages/api-client`, `apps/api` skeleton                                                                                                                     | SDK builds standalone; bundle still served at `/forms/v1.js`; public submit contract unchanged (submit-route tests green)                                                                   |
| 7 — Dashboard app                     | `apps/dashboard` (dashboard + auth pages + proxy)                                                                                                                              | Dashboard + auth flows work; session/cookie behavior unchanged                                                                                                                              |
| 8 — Marketing / Docs / Updates        | `apps/marketing`, `apps/docs`, `apps/updates`                                                                                                                                  | Landing, changelog, terms, docs render; SEO routes (sitemap/robots) keep working                                                                                                            |
| 9 — Email, queue, worker              | `packages/email`, `packages/queue` (abstraction over the DB outbox), `services/email-worker`                                                                                   | Outbox retries + cron behavior unchanged; worker has a real entry point, health + graceful shutdown                                                                                         |
| 10 — Security / observability / infra | `packages/security`, `packages/observability`, `infrastructure/cloudflare`                                                                                                     | Headers, audit logging, structured logging wired; Cloudflare build still green                                                                                                              |
| 11 — MCP foundation                   | **Deferred entirely (owner decision 2026-11-18).** Design docs only, if the owner wants them; no `packages/mcp` code, no `apps/mcp`.                                           | —                                                                                                                                                                                           |
| 12 — AI foundation                    | **Deferred entirely (owner decision 2026-11-18).** Design docs only, if the owner wants them; no `packages/ai` code.                                                           | —                                                                                                                                                                                           |
| 13 — Verification + docs              | Tests moved with code, `docs/architecture/*`, `docs/development/*`, `docs/operations/*`, AGENTS.md/CLAUDE.md/skill refs updated, `docs/architecture/migration-final-report.md` | Full gates green on the feature branch; final report complete; `main` still untouched; no PR opened unless the owner asks                                                                   |

**Commit discipline:** one logically complete unit per commit, on the feature
branch only, in the repo's commit style (`type(scope): description`,
lowercase imperative, <72 chars). No merges into `main`. No PR unless the
owner asks. No production deployment. No production DB change.

**Open decisions for the owner (before Phase 2 starts):**

1. Proceed with this sequence, or adjust the phase order?
2. `apps/*` directory naming: plain (`apps/marketing`) vs the brief's
   domain-suffixed names (`apps/marketing/sendcms.com`)?
3. Add `feature/**` to `ci.yml` via web UI so pushes to this branch run CI
   (otherwise verification is local gates + PR-triggered CI)?
4. Production domain (jadoo.bond vs openremark.bond) — still open; it decides
   the SDK/canonical URLs and the `FALLBACK_APP_URL`. The migration does not
   need it, but the split apps' deployment configs will.
5. MCP/AI scope for this migration: honest boundaries + design docs (as
   proposed above), or defer them entirely to a follow-up?
