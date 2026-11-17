# SendCMS Transformation Plan — OpenRemark → Contact Form Backend SaaS

Repo: `DashingMZA/sendcms` · Base: single commit `44c342c` (copy of open-remark @ `8fcd492`)
Plan date: 2026-11-17 · Status: **approved 2026-11-17** — Phase 0 done + pushed
(`d58fe6c`, CI green on `5ee0ac1`); Phase 1 done (see §5); Phase 2 done
(see §5).

Conventions: follow `AGENTS.md` + `.agents/skills/project-guidelines/` (layered flow,
RBAC, schema rules, route templates). Work on branch `feat/contact-form-saas`,
one phase per commit, push after each verified phase. No destructive production
DB operation without explicit approval.

## 1. Audit summary (verified in source, 2026-11-17)

- Stack: Next.js 16.4.6 (App Router, Turbopack), React 19.3.1, TypeScript 6.0.3,
  Prisma 7.10.1 + PostgreSQL (`@prisma/adapter-pg`), Better Auth 1.7.25
  (stable) + Prisma adapter, database sessions — switched from Auth.js v5
  (`next-auth` 5.0.0-beta.32) on 2026-11-17 per user decision (see Phase 0),
  Tailwind v4, shadcn/ui, React Query 5,
  Zod 4, Nodemailer 10 + React Email, esbuild widget → `public/embed.js`,
  Cloudflare OpenNext (`@opennextjs/cloudflare` 1.20.17).
- Size: 320 files, ~19,300 LOC (`app/`, `lib/`, `components/`, `widget/`,
  `prisma/`, `scripts/`, `config/`), 15 Prisma migrations, 13 models.
- **Baseline green:** `pnpm install` OK · `typecheck` clean (0 errors) ·
  `lint` 0 errors, 1 warning (`app/dashboard/error.tsx:35` `window.location.href`) ·
  `next build` SUCCESS (dummy env, no live DB).
- **No tests, no CI.** Zero `*.test.*` files, no test script, no `.github/workflows/`.
  Husky pre-commit runs lint + format:check + typecheck only.

### Key findings (audit report — full detail in chat 2026-11-17)

**Security (fix in transformation):**
1. `lib/auth-widget.ts:11` — `WIDGET_JWT_SECRET ?? "fallback-secret"`: unset secret ⇒ forgeable widget JWTs.
2. `lib/cors.ts` — empty allowlist returns `true` (any origin allowed); `GET /api/widget/comments` never checks origin.
3. `lib/db.ts:13-22` — strips `?sslmode=` and sets `ssl: { rejectUnauthorized: false }` (MITM-able).
4. No CSRF protection on cookie-session `/api/v1/*` mutations.
5. Rate limit is an in-memory `Map` (per-isolate on Workers — doesn't hold globally), keyed on spoofable `x-forwarded-for`; `/api/v1/*` has no rate limiting at all.
6. Widget Google `id_token` validated via `tokeninfo?id_token=…` (query string), never checks `email_verified`.
7. Domain validation regex accepts `:` and `/`; `Site.domain` not `@unique`, no normalization, no index.
8. SMTP transporter has `logger: true, debug: true` in production.

**Correctness / gaps:**
9. No spam detection (`SPAM` status never assigned), no honeypot, no Turnstile, no idempotency.
10. Email is synchronous in the request path, failures swallowed (`console.error`), silently skipped when no SMTP configured. No queue/retries/tracking.
11. Auth is Google-only. No GitHub/Facebook, no email/password, no password reset. `VerificationToken` model unused; `User.emailVerified` never read; nothing gates on verified email.
12. `Site.allowAnonymous` is dead (widget POST always requires Bearer token). Replies are 2-level only. Widget/server char-limit mismatch (2,000 vs 5,000).
13. Stubs shipped in prod: `/dashboard/settings` and `/dashboard/notice-board` ("coming soon"), `/elements` design showcase.
14. Docs/schema drift: schema doc claims `Site.domain @unique` (false), `EmbedConfig` (doesn't exist), `Json` columns (violated by `Site.allowedOrigins String`), `createdAt+updatedAt` everywhere (violated by `Page`, `CommentLike`, `ModerationLog`).
15. Deployment: `wrangler.jsonc` has no `build` key; `build:cf` skips `prisma generate` + `widget:build` (clean checkout fails or ships stale/missing `embed.js`). Dual production URLs: `jadoo.bond` (wrangler vars) vs `openremark.bond` (README/vercel.json/docs). No CSP/security-headers file for Cloudflare.
16. Root clutter: stray `.sitepins/config.json` + `.sketivo/config.json` (other projects), committed `tsconfig.tsbuildinfo` (604K) and `generated/` (Prisma client, 1M) that belong in `.gitignore`; three deploy targets at once; leftover "Zeon" branding (`window.ZeonComments`, `zeon_widget_token`, DB name `zeon`).

### Reusable as-is (keep, extend)
Next.js dashboard shell + sidebar/nav; Prisma/Postgres + `lib/db.ts`; Better Auth 1.7.25 + Prisma adapter + database sessions (switched from Auth.js v5, 2026-11-17);
`Site`/`SiteMember`/`SiteInvite` + `requireSiteAccess` + `lib/permissions/*`; email rendering pattern
(React Email layout); widget build pipeline (esbuild IIFE + lightningcss, compile-time defines);
`lib/api/*` response/error helpers; Zod validators pattern; `lib/cors.ts` + `lib/rate-limit.ts`
(shape); `lib/sanitize.ts`; dashboard UI primitives + tables/charts/search; React Query data layer
(`lib/api-client.ts`, `lib/queries/*`); health check.

### Comment-only — remove
`Page`, `Commenter`, `Comment`, `CommentLike`, `ModerationLog`, `BannedCommenter` models;
`comment-service`, `moderation-service`, `page-service`, comment validators/queries;
`/api/v1/comments/*`, `/api/widget/comments/*`, `/api/widget/auth`, `/api/widget/oauth-callback`,
`/api/widget/commenters`, `/api/widget/me`, `/api/subscribe`, `/api/unsubscribe`;
widget comment UI + Google PKCE commenter auth; moderation/ban/subscription dashboard sections;
comment email templates (`new-comment`, `reply`, `like`); `public/demo.html`; demo seed data
(commenters incl. `spam@evil.com`, fixed `siteKey: "demo-site-key-001"`).

## 2. Target product (per brief)

Centralized contact-form backend for Astro, Next.js, Hugo, Jekyll, Gatsby, Nuxt,
SvelteKit, React, Vue, WordPress, plain HTML — anything that can make HTTP requests.
Static sites need no backend of their own; all processing happens on SendCMS.
Public identifiers only (`userId`, `formId`); no secrets in the browser bundle.

## 3. Target folder structure (professional SaaS layout)

Root stays lean — only standard files (`package.json`, `tsconfig.json`, configs,
`proxy.ts`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `LICENSE`) plus top-level
`app/`, `components/`, `lib/`, `prisma/`, `sdk/`, `config/`, `docs/`, `scripts/`,
`public/`, `tests/`, `.github/`. Root cleanup: delete `.sitepins/`, `.sketivo/`;
gitignore `generated/` + `tsconfig.tsbuildinfo`; remove `/elements` from prod;
`content/` stays for marketing pages; `docs/superpowers/` archived.

```
sendcms/
├── app/
│   ├── (marketing)/              # /, /changelog, /terms
│   ├── (auth)/                   # sign-in, register, verify-email, reset-password
│   ├── dashboard/
│   │   ├── page.tsx              # Overview
│   │   ├── domains/              # list, new, [domainId] (detail, verify, settings)
│   │   ├── forms/                # list, new, [formId] (fields, domains, notifications)
│   │   ├── inbox/                # submissions list + [submissionId]
│   │   ├── notifications/        # preferences + email-job delivery log
│   │   ├── analytics/
│   │   ├── api-sdk/              # SDK snippet, REST docs links
│   │   ├── settings/             # account settings (real — replaces stub)
│   │   └── administration/       # platform owner (keep)
│   └── api/
│       ├── auth/[...all]/       # Better Auth handler
│       ├── health/
│       ├── v1/                   # admin API, session-gated (existing pattern)
│       └── public/v1/            # public submission API (CORS + rate-limited)
├── components/
│   ├── ui/                       # shadcn primitives (keep)
│   ├── dashboard/                # sidebar, nav, tables, charts (inbox-focused)
│   └── marketing/
├── lib/
│   ├── api/                      # response/error (keep)
│   ├── auth/                     # auth.ts, auth.config.ts, verification
│   ├── cors.ts, rate-limit.ts, sanitize.ts   # keep, harden (see §6)
│   ├── db.ts                     # Prisma singleton (keep, fix SSL)
│   ├── email/                    # platform transport, templates, queue worker
│   ├── permissions/              # keep, extend capabilities (forms/submissions)
│   ├── queries/                  # React Query hooks per resource
│   ├── services/                 # domain, form, submission, notification,
│   │                             # verification, audit (no Next.js imports)
│   ├── validators/               # Zod per resource
│   └── utils.ts
├── prisma/                       # schema + migrations (keep)
├── sdk/                          # vanilla-TS form SDK (renamed from widget/)
│   ├── src/                      # index, api, render, styles, types
│   └── build.ts                  # esbuild → public/forms/v1.js (+ debug)
├── config/config.json            # keep, rebrand values (no vendor IDs)
├── docs/                         # rewritten docs (see §8)
├── scripts/                      # db-manager, seed (rewritten, no demo spam)
├── public/                       # static assets; embed.js → forms/v1.js
├── tests/                        # NEW: vitest (services, validators, SDK)
└── .github/workflows/            # NEW: CI (typecheck, lint, build, tests)
```

## 4. Dependencies — latest, verified live from npmjs (2026-11-17)

Script: `~/workspace/scripts/check-latest-deps.py` (queries `registry.npmjs.org`).
Most deps are already at latest. Updates to apply in Phase 0 (patch/minor only):
`@tanstack/react-query` 5.107.1 → 5.108.0, `eslint` 10.14.0 → 10.15.0,
`lucide-react` 1.72.0 → 1.74.0, `marked` 18.2.0 → 18.2.1,
`nodemailer` 10.5.0 → 10.6.0, `postcss` 8.5.32 → 8.5.33,
`react-email` 6.11.12 → 6.11.15, `recharts` 3.10.1 → 3.11.0,
`wrangler` 4.161.0 → 4.164.0. Re-check live again at upgrade time.
**Do NOT blindly take `latest`:**
- `next-auth`: REMOVED — replaced by **`better-auth` 1.7.25** (latest stable,
  verified live 2026-11-17; no beta). `AUTH_SECRET`/`NEXTAUTH_URL` →
  `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`; auth tables reshaped to Better
  Auth shapes in migration `20261117224500_switch_auth_to_better_auth`.
- `prisma`: `latest` = **8.0.0-rc.34 (release candidate)** — stay on 7.10.1 stable.
- `typescript` 7.0.2 is a major (native port) — EVALUATED AND REJECTED in
  Phase 0: `typescript-eslint` 8.73.0 (latest stable) hard-crashes on TS 7
  (`Cannot read properties of undefined (reading 'Cjs')`); TS 7 support
  needs TS 7.1 dev/beta via `@typescript/native`, which breaks the no-beta
  rule. Stay on **6.0.3** (latest 6.x stable) until typescript-eslint
  supports TS 7.1+ stable.
- New deps to add (Phase 0/8): `vitest` (+ `jsdom` for SDK tests) for testing;
  `resend` for platform transactional email (recommended, see §7 decision).
  Remove after comment code is gone: anything only used by it (verify with
  `pnpm why` / grep before removing).

## 5. Implementation phases (one phase = one verified commit)

**Phase 0 — Foundations.** Dependency upgrades (§4, re-checked live) + root
cleanup (§3) + folder restructure skeleton + CI workflow + Vitest setup +
`AGENTS.md`/`CLAUDE.md`/docs updated for the new structure + auth switched
to Better Auth 1.7.25 (schema reshaped, migration
`20261117224500_switch_auth_to_better_auth`, `auth()` helper kept so all
call sites stay unchanged). Gate: typecheck, lint, build green.

**Phase 1 — Schema + migrations.** New models per brief §13 (`Domain`,
`DomainVerification`, `Form`, `FormDomain`, `FormField`, `Submission`,
`SubmissionEvent`, `NotificationSettings`, `EmailJob`, `AuditLog`; keep `User`,
`Account`, `Session`, `Verification` (Better Auth shapes — already migrated
in Phase 0, migration `20261117224500_switch_auth_to_better_auth`). `Site` → `Domain` concept (rename
with migration, keep `siteKey`→ public form/user IDs model). Non-destructive:
new tables first; comment tables dropped only in a later, separately approved
step. Backup note in migration docs. Gate: `prisma validate`, migration SQL
reviewed, `prisma generate`, typecheck. **Status: DONE 2026-11-17** —
migration `20261117185033_add_contact_form_models` (10 new tables + 10 enums,
additive only, generated offline via `migrate diff` — no live Postgres in the
sandbox); gate green (validate, generate, typecheck clean, lint 0 errors /
1 pre-existing warning, tests 6/6, build SUCCESS dummy env). `Site` was NOT
renamed to `Domain`: a fresh `Domain` model was created alongside it, since
the two concepts have different shapes and `Site` + comment tables stay
untouched until the separately approved removal step.

**Phase 2 — Auth.** Add GitHub + Facebook OAuth, credentials (email/password)
with secure hashing, email verification (mandatory before domain registration
or submissions; use Better Auth's built-in verification + `Verification`
table), password reset, account settings,
logout. Validate OAuth `email_verified` claims; fall back to own verification
when untrusted. Fix first-user `PLATFORM_OWNER` race. Gate: manual journey
register → verify → login (all providers). **Status: DONE 2026-11-17** —
Better Auth `emailAndPassword` (requireEmailVerification, min 8 chars) +
`emailVerification` (sendOnSignUp, autoSignInAfterVerification, 24h expiry)
+ GitHub/Facebook OAuth (env-gated via `lib/auth-providers.ts`; UI only
offers configured providers) + `user.changeEmail`. Auth mail
(`lib/email/auth-mailer.ts`) via platform SMTP (`SMTP_*`); no SMTP → dev
logs the link server-side, production throws. Verification trust verified
in better-auth 1.7.25 source: Google profile `email_verified`, GitHub
`/user/emails` verified flag, Facebook none (gets a verification email on
sign-up). Owner race fixed with a single-statement conditional UPDATE +
partial unique index (migration `20261117190655_single_platform_owner`).
Pages: sign-up, forgot-password, reset-password (query token — the
email link is /api/auth/reset-password/:token, which redirects here with
?token=…; the earlier /reset-password/[token] route never received the
redirect), verify-email; sign-in gained an email form; account page gained
verification status/resend, name, email change (verification to the NEW
address), password change (revokes other sessions), provider linking. The
forgot-password form MUST pass redirectTo "/reset-password" or the reset
link lands on an error. Gate green
(typecheck clean, lint 0 errors / 1 pre-existing warning, tests 25/25,
build SUCCESS dummy env). Manual live journey (real OAuth + SMTP + DB)
still needs the owner on his machine — see the Phase 2 report checklist.

**Phase 3 — Domains.** CRUD, normalize (lowercase, strip scheme/path, www/
subdomain handling), `@unique` + index, ownership verification via DNS TXT
(`sendcms._domainkey.<domain>`, crypto-random challenge), HTML meta-tag and
verification-file alternatives, status / reverify / suspend / reactivate.
DNS checks via DNS-over-HTTPS (portable on Workers) — never Origin/Referer
alone as proof. Gate: verify a real domain end-to-end.

**Phase 3 status — DONE 2026-11-17.** `lib/services/domain-service.ts`
(normalize — lowercase, strip scheme/userinfo/port/path, trailing dot,
leading www; subdomains other than www kept; `assertValidDomain` rejects
localhost/IPs/wildcards; challenge = 24 random bytes base64url, 7-day TTL,
10 attempts max) + `lib/services/dns-verification.ts` (DoH: Cloudflare
first, Google fallback, 5s timeout; TXT segments joined; meta-tag/file
checks fetch the owner's own site over HTTPS with an SSRF guard — DoH A/AAAA
lookup first, refuse private/loopback IPs, same-host redirects only, 5s
timeout, 1 MB cap). Routes: `GET/POST /api/v1/domains`,
`GET/PATCH/DELETE /api/v1/domains/[domainId]`,
`POST /verify`, `POST /reverify`. Domain registration gated on the owner's
email being verified (403 otherwise); suspend/reactivate via PATCH action;
delete blocked while forms are linked (409). AuditLog rows for
CREATE/VERIFY/SUSPEND/REACTIVATE/DELETE. Dashboard: `/dashboard/domains`
(list + badge in sidebar), `/new` (email-verified gate shown when locked),
`/[domainId]` (per-method instructions with copyable snippets via
InstallSnippet, check/reverify/suspend/reactivate/delete). Also fixed the
orphan `app/(dashboard)/layout.tsx` (same sidebar props — it has no pages
but is still typechecked). Tests 61/61 (new: normalization + DoH parsing +
meta-tag extraction + mocked resolver fallback). Live DoH verified:
`_dmarc.google.com` TXT read correctly, nonexistent name → [], failed
check returns the propagation reason. Full positive end-to-end (a real
TXT record on the owner's domain) still needs the owner to add the record
— the challenge is issued per domain from the dashboard.

**Phase 3 follow-up (owner feedback 2026-11-17, after jadoo.bond verified
via DNS):** (1) TXT record name changed from `_contact-verify.<domain>` to
`sendcms._domainkey.<domain>` (Resend-style); already-verified domains are
unaffected. (2) Challenge is now 36 random bytes = 48 base64url chars
(was 24 bytes / 32 chars) so the value is practically unique forever. (3) The challenge
value is the SAME for all three methods — switching methods keeps the
value; a fresh challenge is only issued when no pending verification
exists. (4) DNS instructions now show Name and Value as two separate
copy fields. (5) File instructions explain the public folder (like
ads.txt), copy copies only the code, and a Download button saves
`sendcms-verification.txt` ready to upload. (6) The "Start a new
verification" button is now "Switch method" (disabled when the selected
method is already active).

**Phase 4 — Forms.** CRUD, public `formId`, name/description, active flag,
allowed-domain links (`FormDomain`, many-to-many), notification emails,
field config (`FormField`), success message, redirect URL, spam settings,
submission limits. One form ↔ many domains; many forms ↔ one domain.
Gate: create form, link 2 domains, toggle active.

**Phase 4 status (DONE + PUSHED + CI GREEN 2026-11-17):** commit
`feat(forms): add form CRUD, fields, domain links and notifications`
(local 45529a9 → API **865a802**); CI run 44186889051 = SUCCESS. Live
journey on the dev DB: form created with 3 default fields, PENDING
domain link rejected 409, 2 verified domains linked 201, duplicate
link 409, select field + recipient added, active toggled false then
true, dashboard pages all 200, AuditLog CREATE/UPDATE/DELETE rows
written. Test users/domains/forms cleaned up; 4 owner accounts remain.

**Phase 5 — Public submission API (`/api/public/v1/submit`).** Validate
user/form IDs, domain authorization (exact allowlist, verified domain only),
field + size validation, sanitization, honeypot, optional Turnstile,
spam heuristics, DB-backed rate limiting, idempotency keys
(`(formId, idempotencyKey)` unique; content-hash dedupe window), durable
Postgres save **before** success response, consistent JSON responses,
request-size limits. Fix the §1 security items (no fallback secret, CORS
deny-by-default, CSRF/Origin checks on session mutations, DB SSL).
Gate: scripted tests for valid/invalid domain, invalid IDs, spam, rate
limits, duplicates, oversize payloads.

**Phase 6 — JavaScript SDK (`sdk/`, replaces widget).** Vanilla TS,
dependency-free, small. `<script src="…/forms/v1.js" data-user-id data-form-id>`,
`<form data-cms-form>` auto-enhance, loading/success/error states, duplicate
prevention, multiple forms per page, SPA navigation + Astro transitions,
no style leakage (Shadow DOM or scoped CSS), configurable callbacks/messages.
Also direct REST docs + native HTML POST fallback (no-JS). Reuse the esbuild
pipeline (compile-time defines, debug build). Gate: SDK against a local
static test page + plain-HTML fallback test.

**Phase 7 — Inbox dashboard.** All/unread/read/starred/archived/spam,
search, filter by domain/form/date, detail view (sender, page URL,
timestamps), mark read/unread, archive/delete, bulk ops. Strict user-level
isolation (every query scoped by owner). Reuse table/search/filter patterns.
Gate: seeded submissions exercised through the UI journey.

**Phase 8 — Email notifications.** Platform transactional email (Resend
recommended — no user SMTP for basic notifications), form-specific +
multiple recipients, customizable templates (submission, verification,
password reset), sender/page/domain context, preferences + enable/disable,
`EmailJob` outbox with retries + delivery tracking, cron worker route.
Submissions never lost when email is down (saved first, job queued).
Gate: submission → job → delivered email observed; provider outage simulated
(submission still stored).

**Phase 9 — Dashboard completion.** Overview, Domains, Forms, Inbox,
Notifications, Analytics, API & SDK, Account Settings — all real, no stubs,
empty/loading/error states, validation. Remove all comment UI. Rebrand
config values (no GTM ID, Product Hunt badge, csofts links, openremark.bond).
Gate: click-through of every nav section.

**Phase 10 — Documentation rewrite.** Quick start, registration, email
verification, domain registration + DNS TXT/meta/file verification, creating
forms, Astro/Next.js/Hugo/plain-HTML integrations, REST API, SDK, HTML
fallback, security + troubleshooting, deployment, env config. Update
`AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/architecture.md`.
Gate: docs followed verbatim on a fresh static test page.

**Phase 11 — Testing + deployment verification.** Automated tests for new
functionality (validators, services, SDK, API happy/edge paths); full
16-step user journey from the brief (§16) executed and recorded; fix
regressions; verify Cloudflare deploy compatibility (fix `wrangler.jsonc`
build chain: `prisma generate && sdk build && build:cf`; security headers;
resolve `jadoo.bond` vs `openremark.bond`); final factual report
(implemented / removed / tests / limitations / deployment requirements).

## 6. Decisions needed from the user (before / during implementation)

1. **Approve this plan** (or say what to change). Implementation starts only after approval.
2. **Email provider:** Resend (recommended — API key needed from user when we reach Phase 8) or platform SMTP via env vars?
3. **Production domain + deploy target:** Cloudflare Workers (current, `jadoo.bond` in wrangler) or Vercel (`openremark.bond`)? The SDK URL (`cdn.example.com/forms/v1.js`) follows from this.
4. **Database for dev/testing:** migrations + journey tests need a Postgres. Options: user provides a dev `DATABASE_URL`, or local Postgres in the sandbox if available. (Sandbox cannot reach the user's Prisma Postgres — same as varka-cms history.)
5. **Turnstile:** enable optional Cloudflare Turnstile per form (needs sitekey/secret in env) or honeypot + rate limiting + heuristics only?
6. **Branch:** work on `feat/contact-form-saas`, one commit per phase, push after each verified phase — OK?

## 7. Risks / limitations (stated upfront)

- Better Auth 1.7.x is stable but newer than NextAuth — smaller community,
  minors can carry breaking changes; version is pinned exact (1.7.25).
  GitHub/Facebook providers + credentials need care and manual verification.
- Prisma 8 RC deliberately NOT adopted (see §4). TypeScript stays 6.0.3;
  TS 7.0.2 was evaluated and rejected (typescript-eslint lint crash, §4).
- DNS TXT verification from Workers uses DNS-over-HTTPS; full end-to-end proof needs a real domain the user controls.
- Email delivery proof needs a real provider key (Resend) and a real inbox.
- No live production DB exists in the sandbox; destructive migration steps (dropping comment tables) are deferred to a separate, explicitly approved step with a backup.
