# SendCMS Transformation Plan — OpenRemark → Contact Form Backend SaaS

Repo: `DashingMZA/sendcms` · Base: single commit `44c342c` (copy of open-remark @ `8fcd492`)
Plan date: 2026-11-17 · Status: **approved 2026-11-17** — Phase 0 done + pushed
(`d58fe6c`, CI green on `5ee0ac1`); Phase 1 done (see §5); Phase 2 done
(see §5).

Conventions: follow `AGENTS.md` + `.agents/skills/project-guidelines/` (layered flow,
RBAC, schema rules, route templates). Work on branch `feat/contact-form-saas`,
one phase per commit, push after each verified phase. No destructive production
DB operation without explicit approval.

📌 **Status note (2026-11-22):** this is a historical record of the plan
as written on 2026-11-17 — its claims, dates, SHAs, and counts are kept
as written. What changed since: Phases 0–11 all completed (see
[sendcms-final-report.md](sendcms-final-report.md)), the comment system
was removed and the branch was shifted to `main` (§ "Post-Phase 11"),
the monorepo migration completed (see
[architecture/migration-final-report.md](architecture/migration-final-report.md)),
the production domain **is decided** (`sendcms.bond`), MCP and AI were
built on `feature/ai`, and the admin control plane is in progress on
`feature/admin-control-plane`.

## Contents

- [1. Audit summary (verified in source, 2026-11-17)](#1-audit-summary-verified-in-source-2026-11-17)
- [2. Target product (per brief)](#2-target-product-per-brief)
- [3. Target folder structure (professional SaaS layout)](#3-target-folder-structure-professional-saas-layout)
- [4. Dependencies — latest, verified live from npmjs (2026-11-17)](#4-dependencies--latest-verified-live-from-npmjs-2026-11-17)
- [5. Implementation phases (one phase = one verified commit)](#5-implementation-phases-one-phase--one-verified-commit)
- [Post-Phase 11 — comment-system removal + branch shift (2026-11-18)](#post-phase-11--comment-system-removal--branch-shift-2026-11-18)
- [6. Decisions needed from the user (before / during implementation)](#6-decisions-needed-from-the-user-before--during-implementation)
- [7. Risks / limitations (stated upfront)](#7-risks--limitations-stated-upfront)

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

**Correctness / gaps:** 9. No spam detection (`SPAM` status never assigned), no honeypot, no Turnstile, no idempotency. 10. Email is synchronous in the request path, failures swallowed (`console.error`), silently skipped when no SMTP configured. No queue/retries/tracking. 11. Auth is Google-only. No GitHub/Facebook, no email/password, no password reset. `VerificationToken` model unused; `User.emailVerified` never read; nothing gates on verified email. 12. `Site.allowAnonymous` is dead (widget POST always requires Bearer token). Replies are 2-level only. Widget/server char-limit mismatch (2,000 vs 5,000). 13. Stubs shipped in prod: `/dashboard/settings` and `/dashboard/notice-board` ("coming soon"), `/elements` design showcase. 14. Docs/schema drift: schema doc claims `Site.domain @unique` (false), `EmbedConfig` (doesn't exist), `Json` columns (violated by `Site.allowedOrigins String`), `createdAt+updatedAt` everywhere (violated by `Page`, `CommentLike`, `ModerationLog`). 15. Deployment: `wrangler.jsonc` has no `build` key; `build:cf` skips `prisma generate` + `widget:build` (clean checkout fails or ships stale/missing `embed.js`). Dual production URLs: `jadoo.bond` (wrangler vars) vs `openremark.bond` (README/vercel.json/docs). No CSP/security-headers file for Cloudflare. 16. Root clutter: stray `.sitepins/config.json` + `.sketivo/config.json` (other projects), committed `tsconfig.tsbuildinfo` (604K) and `generated/` (Prisma client, 1M) that belong in `.gitignore`; three deploy targets at once; leftover "Zeon" branding (`window.ZeonComments`, `zeon_widget_token`, DB name `zeon`).

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

- GitHub/Facebook OAuth (env-gated via `lib/auth-providers.ts`; UI only
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

**Phase 5 status (DONE + PUSHED + CI GREEN 2026-11-17):** commit
`feat(submissions): add public submission API with origin allowlist`
(local 4621bee → API **f20ab04**); CI run 44196892381 = SUCCESS. Live
journey on the dev DB (17 scripted checks + 9 re-run checks, all
passing): allowed origin 201 with CORS echo, unlinked/unknown/no
origin 403 (no CORS header on rejections), validation 422s (missing
required, bad email, unknown field), idempotency + content-hash dedupe
both return the original id, spam (4 links) saved as SPAM, daily
limit 429 at 2/day, IP hammer 10×201 then 429, honeypot fake 201 with
no row saved, paused form 403, preflight 204. DB proof: form 1 has
exactly 2 submissions (1 NEW + 1 SPAM) with CREATED events and content
hashes; form 2 has 11. Two fixes found live: (1) the first CORS-header
test failure was a test bug (urllib dict is case-sensitive — headers
arrive lowercase on the wire); (2) error responses used the legacy
admin corsHeaders (GET/PATCH/Authorization) — `handleApiError` now
takes an optional headers override and the public route passes its
own `POST, OPTIONS / Content-Type` headers. Test users/forms/domains
cleaned up; 4 owner accounts remain.

**Phase 6 status (DONE + PUSHED + CI GREEN 2026-11-17):** commit
`feat(sdk): add vanilla-TS form SDK and no-JS POST fallback` (local
54c5599 → API **7dcd94c**); docs commit 922964f. **CI run 44201066914
FAILED on `pnpm test`** (fresh checkout has no gitignored SDK
bundle) — fixed by a `pnpm sdk:build` step in ci.yml, uploaded by the
owner via web UI (commit **02a4690**, byte-identical); **CI run
44202653039 = SUCCESS.**

**Phase 7 status (DONE + PUSHED + CI GREEN 2026-11-17):** commit
`feat(inbox): add inbox dashboard with tabs, search, filters and
bulk actions` (API **3571cfa**); **CI run 44208441902 = SUCCESS.**
Inbox service in `submission-service.ts` (owner-scoped through
`form.ownerId` on every query): list with tabs (All = NEW+READ+
STARRED; Unread/Read/Starred/Archived/Spam), search (`data::text`
ILIKE + origin/pageUrl), form/domain/date filters, 20/page,
per-status counts; detail with event timeline; status actions
(read/unread/star/unstar/archive/restore/spam/not-spam) with a
SubmissionEvent in the same transaction; bulk update; hard delete;
unread count for the sidebar badge. Routes
`GET /api/v1/inbox`, `POST /api/v1/inbox/bulk`,
`GET/PATCH/DELETE /api/v1/inbox/[id]`; pages
`/dashboard/inbox` + `/dashboard/inbox/[id]` (opening a NEW
submission marks it read). Tests 120/120 (16 new). Live journey
43/43 checks on the dev DB: 6 seeded submissions (1 auto-SPAM),
all filters/tabs/actions/bulk/delete, cross-user isolation
(404 for another user, 401 without a cookie), pages 200.
Journey users cleaned up; 4 owner accounts intact. Note: node
`fetch` sends no Origin header — Better Auth 1.7.x rejects such
calls with `MISSING_OR_NULL_ORIGIN`; the journey script sends
`Origin: http://localhost:3000` explicitly.

**Phase 8 status (DONE + PUSHED + CI GREEN 2026-11-17):** commit
`feat(notifications): add email outbox with Resend/SMTP provider and
delivery log` (API **8852d32**); **CI run 44212826172 = SUCCESS.**
Provider abstraction `lib/email/provider.ts`: Resend (REST via fetch,
no new dependency) → platform SMTP → none; auth mail now uses the
same provider. Outbox service `lib/services/email-outbox.ts`: enqueue
after the durable save (AWAITED — a fire-and-forget enqueue raced
the `after()` hook and the job was missed; caught live), process
with PENDING→SENDING claim, retries 1m/5m/15m/1h/4h, 5 attempts,
FAILED only when terminal; cron route `GET /api/cron/email-outbox`
(Bearer CRON_SECRET); immediate attempt via the submit route's
`after()` hook; submission-notification React Email template with
sender/page/domain context; delivery log `/dashboard/notifications`

- test-email button on the form detail (direct send, 502 + provider
  message on failure). Tests 132/132 (12 new). Live journey 21/21 on
  the dev DB with NO provider (outage path): submission saved, job
  queued, first attempt failed honestly ("No email provider
  configured", retry scheduled), cron auth 401s, retry attempts=2,
  submission never lost, test email 502, pages 200. **Real delivery
  through Resend is NOT yet verified — needs the owner's RESEND_API_KEY
  (+ RESEND_FROM on a verified domain).** Spam submissions get no
  notification. Docs: `docs/email-notifications.md`.

**Phase 9 — Dashboard completion.** Overview, Domains, Forms, Inbox,
Notifications, Analytics, API & SDK, Account Settings — all real, no stubs,
empty/loading/error states, validation. Remove all comment UI. Rebrand
config values (no GTM ID, Product Hunt badge, csofts links, openremark.bond).
Gate: click-through of every nav section.

**Phase 9 status (2026-11-17): DONE + LIVE-VERIFIED, commit pending push.**
New: `lib/services/dashboard-service.ts` (`getDashboardOverview`,
`getSubmissionAnalytics`, pure `bucketByDay`); `lib/sdk-snippet.ts`
(script-tag / form / REST curl builders); Overview rebuilt as SendCMS
stats (domains, forms, submissions, unread) + 14-day activity chart +
recent submissions; `/dashboard/analytics` (30-day totals, per-day chart,
by form/domain/status); `/dashboard/api` (public userId, SDK snippet,
REST reference, no API keys — Origin allowlist). Removed: `app/dashboard/sites/`,
`app/dashboard/administration/`, `app/dashboard/notice-board/`,
`app/dashboard/settings/` (stub), comment chart components,
`components/product-hunt-badge.tsx`; sidebar Sites/Settings/Notice/
Administration items + site switcher (logo → /dashboard, "New site" →
"New form"); `PLATFORM_ROUTE_CAPABILITY` emptied (its 3 entries gated only
the deleted pages). Rebrand: `config/config.json` → SendCMS (GTM +
Product Hunt + need-help blocks removed, branding disabled, email
`[New Submission]` / `#0891b2`); GTM removed from `app/layout.tsx`,
metadata retitled; landing-page GitHub/footer links fixed to
DashingMZA/sendcms; changelog/terms titles → SendCMS. Live journey
38/38 pass (dev DB, journey user N): all 8 nav pages 200 with real data
(overview shows seeded sender/form, analytics shows By form, API page
shows userId + forms/v1.js), sidebar has Analytics + API & SDK and no
comment links, all 4 removed routes 404. Two bugs found live: (1) the
sidebar site-switcher block still linked /dashboard/sites + /dashboard/sites/new
after the nav edit — fixed to Overview + New form; (2) fetch follows
redirects, so the proxy's capability-gate 307 to /dashboard masqueraded as
a 200 from the deleted pages — journey now uses `redirect: "manual"`.
Gate: format, typecheck clean, lint 0 errors / 1 pre-existing warning,
tests 139/139, build SUCCESS. Remaining rebrand (NOT in this phase):
the landing page body copy + hero embed snippet still describe the
comment system (`app/page.tsx`, `content/homepage.md`, hero video) —
flagged for the Phase 10 pass; `lib/utils.ts` FALLBACK_APP_URL is still
https://openremark.bond because the production domain (§6) is undecided.

**Phase 10 — Documentation rewrite.** Quick start, registration, email
verification, domain registration + DNS TXT/meta/file verification, creating
forms, Astro/Next.js/Hugo/plain-HTML integrations, REST API, SDK, HTML
fallback, security + troubleshooting, deployment, env config. Update
`AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/architecture.md`.
Gate: docs followed verbatim on a fresh static test page.

**Phase 10 status (2026-11-18): DONE + LIVE-VERIFIED, commit pending push.**
New docs: `getting-started.md` (account → domain → form → embed →
inbox → notifications), `rest-api.md` (submit endpoint, status table,
idempotency/dedupe, no-JS 303 fallback), `security.md` (threat model),
`deployment.md` (env table, DB, build, outbox cron, Vercel/Cloudflare
notes), `troubleshooting.md` (auth, domain verification, submissions,
email, SDK), `embed-html.md` (plain HTML). Rewritten: `README.md`,
`docs/architecture.md`, `embed-astro.md`, `embed-nextjs.md`,
`embed-hugo.md` (all now SDK-based, form-level `data-user-id` /
`data-form-id` — the reliable place, since `next/script` loads
dynamically and the script tag's own data attrs are unreadable then),
`AGENTS.md` (SendCMS project, pnpm 12, SDK commands + jsdom note,
legacy seed warning, full env list). `CLAUDE.md` needed no change — it
is just `@AGENTS.md`. Landing page rewritten too (flagged in Phase 9):
`content/homepage.md` (Contact Forms hero, 6 SendCMS features, single
Free $0 plan, 4-step how-it-works) + `app/page.tsx` (SendCMS embed
snippet, HeroVideo removed + `components/hero-video.tsx` deleted —
it was the old comment demo; secondary button opens a new tab only for
external links, `#how-it-works` anchor added; snippet label/filename
updated). Gate: static gate green (typecheck clean, lint 0 errors /
1 pre-existing warning, tests 139/139, build SUCCESS); live journey
28/28 pass (dev DB, journey user O): fresh static page built verbatim
from `docs/embed-html.md` (SDK form + no-JS form) serves 200, SDK-shape
JSON submit → 201, no-JS form POST → 303 with `?cms_submitted=1`,
2 submissions in DB + inbox, landing page 200 with no comment copy /
no Paddle / no demo.html, API & SDK page shows the userId; 4 owner
accounts intact. Follow-up DONE 2026-11-18 (owner: "vercel ko update kr
do, wrangler worker ko b, seed sirf SendCMS"): `vercel.json` DELETED (it
only held the stale openremark.vercel.app → openremark.bond redirect;
no production domain exists to redirect to yet); `wrangler.jsonc`
worker name + self-reference service → `sendcms`, secrets comment
updated to Better Auth names; `prisma/seed.ts` rewritten SendCMS-only
(demo user verified, VERIFIED domain + DNS_TXT record, form
demo-form-001 with default fields, link, notification, 3 sample
submissions incl. 1 SPAM — no Site/Page/Comment/Commenter rows at all).
Seed verified live on the dev DB (run twice: idempotent, still 3
submissions; demo data cleaned up after, 4 owner accounts intact).
Remaining: R2 bucket still `open-remark-opennext-cache` (a real
Cloudflare resource — rename needs a new bucket in the dashboard);
`lib/utils.ts` FALLBACK_APP_URL still openremark.bond (production
domain §6 undecided); `NEXT_PUBLIC_APP_URL` in wrangler vars stays
https://jadoo.bond per the owner's 2026-11-13 decision.

**Phase 11 — Testing + deployment verification.** Automated tests for new
functionality (validators, services, SDK, API happy/edge paths); full
16-step user journey from the brief (§16) executed and recorded; fix
regressions; verify Cloudflare deploy compatibility (fix `wrangler.jsonc`
build chain: `prisma generate && sdk build && build:cf`; security headers;
resolve `jadoo.bond` vs `openremark.bond`); final factual report
(implemented / removed / tests / limitations / deployment requirements).

**Phase 11 status — DONE (2026-11-18).** 67 new tests (suite 139 → 206/206):
`submission-service` (18), `submit-route` (13), `domain-service` (16),
`form-service` (10), `email-outbox-process` (10). Full 16-step journey
43/43 live (`~/workspace/scripts/phase11-journey.mjs`). Cloudflare:
`build:cf` now runs `prisma generate && widget:build && sdk:build &&
opennextjs-cloudflare build` (package.json scripts + `wrangler.jsonc`
`build.command`); `public/_headers` adds nosniff/referrer/frame/
permissions policies (no CSP on purpose — Next inlines scripts/styles,
a CSP would need `unsafe-inline`); worker + SDK bundle + headers verified
in `.open-next`. Bugs fixed: test-file type errors that broke `build:cf`;
eslint OOM on `.open-next` (now in `globalIgnores`). Final report:
`docs/sendcms-final-report.md`. Production domain still undecided (§6);
no live deploy was done in this phase.

## Post-Phase 11 — comment-system removal + branch shift (2026-11-18)

**Comment-system removal — DONE 2026-11-18 (owner-approved "yes remove
kr do").** The separately approved removal step is complete: 9 tables
(`Site`, `Page`, `Commenter`, `Comment`, `CommentLike`, `ModerationLog`,
`BannedCommenter`, `SiteMember`, `SiteInvite`) + 3 enums dropped via
migration `20261118084500_remove_comment_system` (applied to the dev DB —
all 9 tables held 0 rows, so no data was lost; 4 owner accounts, 2
domains, 1 form intact). Deleted: `widget/`, `/api/widget/*`,
`/api/v1/sites/*`, `/api/v1/comments/*`, `/api/v1/users/lookup`,
`/api/subscribe`, `/api/unsubscribe`, 6 comment services, `lib/auth-widget.ts`,
`lib/rate-limit.ts`, `lib/email/email-service.ts`, `lib/sanitize.ts`,
comment email templates, `lib/permissions/site.ts`, 5 query files, 3
validators, `lib/types/commenter.ts`, the administration + site-settings-form

- team component folders, 9 orphaned dashboard components, benchmark
  scripts, `public/demo.html`. `lib/cors.ts` kept minus the legacy
  `isOriginAllowed` (the public submit route still uses
  `getEffectiveOrigin`); `WIDGET_JWT_SECRET` removed from `.env.example`,
  `.dev.vars.example`, wrangler comments, AGENTS.md, README, deployment
  docs; terms.md rewritten SendCMS-only; skill references updated to
  SendCMS. Gate green: format, typecheck clean, lint 0 errors / 1
  pre-existing warning, tests 202/202 (4 `siteCan` tests removed with the
  feature), `pnpm build` + `pnpm build:cf` SUCCESS (`.open-next` has no
  `embed.js` anymore), full 16-step journey 43/43 live.

**Branch shift — DONE 2026-11-18 (owner: "main branch empty kr k, just
1 branch ho").** `main` was force-updated to the `feat/contact-form-saas`
tip and the feat branch deleted; the repo now has exactly one branch
(`main`) holding the SendCMS code. The old `main` tip (`44c342c`, the
original open-remark copy) is superseded — the original open-remark repo
is untouched. CI runs on pushes to `main`.

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
