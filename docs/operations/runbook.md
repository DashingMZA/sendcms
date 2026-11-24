# Operations runbook

How SendCMS runs in production. Deployment (builds, dashboard steps,
per-app wrangler files) lives in [Deployment](../deployment.md) and
`infrastructure/cloudflare/README.md`; this document is the
day-to-day operating picture: what runs where, what the env vars do,
and what to check when something is wrong.

📌 **Production is `sendcms.bond`** (decided 2026-11-20), running the
`feature/ai` branch on Vercel. The `feature/admin-control-plane`
branch (this branch) is **not deployed** — the ✅ items marked
"on this branch" below exist in code here, not in production.

## Contents

- [What runs where](#what-runs-where)
- [Environment variables (per app)](#environment-variables-per-app)
- [The email outbox (how notifications actually flow)](#the-email-outbox-how-notifications-actually-flow)
- [Logs and the audit log](#logs-and-the-audit-log)
- [Security posture (what is and isn't in place)](#security-posture-what-is-and-isnt-in-place)
- [When something is wrong](#when-something-is-wrong)

## What runs where

Five Cloudflare Workers, one per app (Phase 10). Each app owns its
`wrangler.jsonc` + `open-next.config.ts`; the shared OpenNext config
(R2 incremental cache) lives in `infrastructure/cloudflare/`.

| App       | Worker name         | Serves                                          |
| --------- | ------------------- | ----------------------------------------------- |
| marketing | `sendcms-marketing` | Landing, terms, sitemap, robots                 |
| api       | `sendcms`           | All API routes, auth, public submit, SDK bundle |
| dashboard | `sendcms-dashboard` | Auth pages + dashboard                          |
| docs      | `sendcms-docs`      | User docs                                       |
| updates   | `sendcms-updates`   | Changelog                                       |

All five share one R2 bucket (`open-remark-opennext-cache`) for the
incremental cache — it is a real Cloudflare resource, so renaming it
needs a new bucket created in the dashboard first. The workers also
share the Images binding and the self-reference service binding
(`WORKER_SELF_REFERENCE` → the worker's own name).

The **email worker** (`services/email-worker`) does **not** deploy to
Cloudflare Workers — it is a long-running Node process (`GET /health`
on `WORKER_PORT`, default 3005; polls the outbox every
`WORKER_POLL_INTERVAL_MS`, default 30 s; graceful SIGTERM/SIGINT
shutdown). Its production hosting is a separate decision. Until it is
hosted, the cron route (`GET /api/cron/email-outbox`) is the hosted
drain for failed deliveries — schedule it every 5 minutes with a
`Bearer <CRON_SECRET>` header (on Vercel Hobby it currently runs once
daily; see [Deployment](../deployment.md#email-outbox-cron)).

The **admin app** (`apps/admin`, :3006, `admin.sendcms.bond`) exists
only on the `feature/admin-control-plane` branch — it is not deployed
and not part of the five-worker Cloudflare set above. Its own
`wrangler.jsonc` already uses `sendcms.bond` vars.

⚠️ The five original apps' `wrangler.jsonc` `vars` still use
`jadoo.bond` hosts as placeholders (`https://jadoo.bond`,
`https://api.jadoo.bond`, `https://dashboard.jadoo.bond`, …) even
though the production domain is decided. When the domain is decided
for the Cloudflare path, change the `vars` in all five
`wrangler.jsonc` files together — and the `FALLBACK_APP_URL` in the
per-app `lib/utils.ts` files, which uses the same placeholder.

## Environment variables (per app)

Secrets are set in the Cloudflare dashboard per worker, never in a
file. `wrangler.jsonc` holds only non-secret `vars` (plus a comment
listing the secrets each worker needs). The full table with
descriptions is in [Deployment](../deployment.md#environment-variables).

| Variable                                                  | Where                            | Notes                                                                                      |
| --------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                            | api, dashboard, admin            | Postgres connection string (`?sslmode=verify-full` for Prisma Postgres).                   |
| `BETTER_AUTH_SECRET`                                      | api, dashboard, admin            | Random 32+ char secret. No fallback — auth refuses to start without it.                    |
| `BETTER_AUTH_URL`                                         | api                              | The api app's public URL (the auth handler lives there).                                   |
| `TRUSTED_ORIGINS`                                         | api                              | Comma-separated origins allowed to call auth (the dashboard and admin apps' URLs).         |
| `NEXT_PUBLIC_APP_URL`                                     | all six                          | The marketing app's public URL.                                                            |
| `NEXT_PUBLIC_API_URL`                                     | marketing, dashboard, api, admin | The api app's public URL (SDK bundle origin + submit API).                                 |
| `NEXT_PUBLIC_DASHBOARD_URL`                               | marketing, dashboard, api, admin | The dashboard app's public URL (auth callback + inbox links).                              |
| `NEXT_PUBLIC_DOCS_URL`                                    | marketing, docs                  | The docs app's public URL.                                                                 |
| `NEXT_PUBLIC_UPDATES_URL`                                 | marketing, updates               | The updates app's public URL.                                                              |
| `NEXT_PUBLIC_AUTH_URL`                                    | dashboard, admin                 | The api app's public URL (the auth client talks to it).                                    |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`               | api                              | Google OAuth. Redirect URI: `<API_URL>/api/auth/callback/google`.                          |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`               | api                              | GitHub OAuth (only offered when set).                                                      |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`           | api                              | Facebook OAuth (only offered when set).                                                    |
| `RESEND_API_KEY`                                          | api                              | Resend API key (set separately in deployment env).                                         |
| `RESEND_FROM`                                             | api                              | A sending address on a verified Resend domain.                                             |
| `SMTP_*`                                                  | api                              | SMTP fallback when no Resend key is set.                                                   |
| `CRON_SECRET`                                             | api                              | Bearer token for the email-outbox cron.                                                    |
| `TURNSTILE_SECRET_KEY` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | api                              | Cloudflare Turnstile (forms that enable it answer 503 without the secret).                 |
| `COOKIE_DOMAIN`                                           | api, dashboard, admin            | Production only, when the apps run on subdomains of one domain. Unset = host-only cookies. |
| `LOG_LEVEL`                                               | all                              | `info` / `warn` / `error` (default `info`).                                                |
| `WORKER_PORT` / `WORKER_POLL_INTERVAL_MS`                 | email worker                     | Defaults 3005 / 30000.                                                                     |

## The email outbox (how notifications actually flow)

```mermaid
flowchart TB
    Save["Submission saved (201)"]
    Enqueue["after(): enqueue one EmailJob\nper enabled NotificationSettings row"]
    Claim["Claim atomically\nPENDING → SENDING (attempts +1)"]
    Send["Send via Resend → SMTP → none"]
    Sent["SENT"]
    Fail["FAILED + backoff\n1m / 5m / 15m / 1h / 4h (5 attempts)"]
    Cron["Cron route (every 5 min, or daily on Hobby)\n+ email worker (every 30 s)"]

    Save --> Enqueue --> Claim --> Send
    Send -- "ok" --> Sent
    Send -- "error" --> Fail
    Cron --> Claim
```

1. A submission is saved (201). In `after()`, the submit route
   enqueues one `EmailJob` per enabled `NotificationSettings` row and
   runs `processEmailOutbox()` once for immediate delivery.
2. A due job is claimed atomically (`PENDING` → `SENDING`, attempts
   incremented), sent via Resend → SMTP → none, then marked `SENT`
   or, on failure, `FAILED` with a backoff (1m / 5m / 15m / 1h / 4h,
   5 attempts). A job whose send fails with no provider configured
   stays `PENDING` — the send is retried, never lost.
3. The cron route and the email worker both drain the same outbox
   (`processEmailOutbox({ limit })`); the worker polls every 30 s,
   the cron every 5 min. Either can run alone; running both is safe
   (claiming is atomic).
4. Auth mail (verification + password reset) does **not** go through
   the outbox — it is sent directly, and with no provider configured
   the dev server logs the link (`[auth-email] …`) while production
   fails loudly.

## Logs and the audit log

- Server logs are JSON lines (`createLogger(scope)` from
  `@sendcms/observability`): `{ timestamp, level, scope, message,
...fields }` on stdout (info/warn) or stderr (error). An `error`
  field holding an Error is flattened to `{ name, message, stack }`.
  Scope values: `api`, `submissions`, `email-worker`, `audit`.
  `LOG_LEVEL` gates the level.
- The **audit log** (`AuditLog` table) records domain, form,
  submission, and user actions (CREATE/UPDATE/DELETE/VERIFY/SUSPEND/
  REACTIVATE) via the one `logAudit()` writer in `@sendcms/security`.
  It never blocks the action it records (best-effort, never throws)
  and never records submission content. There is no admin UI for
  reading it — query the table directly. (On the
  `feature/admin-control-plane` branch there is an audit explorer at
  `/admin/audit-logs` — see
  [admin-control-plane/admin-audit-trail.md](../admin-control-plane/admin-audit-trail.md).)
- What to check first when something is wrong: the api worker's logs
  for `scope: "api"` errors (unhandled API errors) and
  `scope: "submissions"` errors (failed notification enqueue); the
  worker's logs for `scope: "email-worker"` poll failures; and the
  `EmailJob` table for stuck `PENDING` jobs (a job stuck past its
  5th attempt is `FAILED` — terminal, needs a human look).

## Security posture (what is and isn't in place)

- Security headers come from one shared definition in
  `@sendcms/security` (each app's `next.config.mjs` `headers()` +
  that app's `public/_headers`). ✅ On this branch (Phase 9) a
  nonce-based Content-Security-Policy is **enforcing** on all five
  page apps — see
  [admin-control-plane/csp.md](../admin-control-plane/csp.md). It is
  **not deployed** (this branch is unmerged); production still has
  no CSP.
- ✅ On this branch (Phase 9) the admin REST API and the auth routes
  **are rate limited** (admin API 600/min + 10,000/hour per user;
  sign-in 20/min per IP + 10/min per email) — see
  [admin-control-plane/rate-limiting.md](../admin-control-plane/rate-limiting.md).
  In production (the `feature/ai` branch) the gap from ADR 0008 still
  stands: the public submit API is the only rate-limited surface
  (DB-backed: 10/min + 100/hour per IP, per-form daily cap).
- Registration is enable/disable-able from dashboard settings; new
  users are never auto-approved (the admin manually approves each
  account); email verification after registration is mandatory.
  Sensitive profile actions (password/email changes, 2FA changes)
  require email-OTP verification on top of password confirmation.
- ✅ On this branch there **is** an MCP server (`POST /api/mcp`,
  19 tools, bearer API keys — see [MCP](../mcp.md)) and AI features
  (`packages/ai`: spam re-scoring, digest, form-builder, reply
  drafts). Both are live on the `feature/ai` production branch; the
  admin-side MCP controls live on this branch only.

## When something is wrong

| Symptom                                   | First check                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submissions not arriving in the inbox     | The api worker's logs; then the `Submission` table (was it saved?) vs the `EmailJob` table (was the notification enqueued?). A 201 with no inbox row means the save failed — check the submit route's `scope: "submissions"` error. |
| Emails not arriving                       | `EmailJob` rows for the form (stuck `PENDING` = the drain isn't running — check the cron schedule / worker health; `FAILED` = provider error, read the job's error). Then the Resend dashboard.                                     |
| Sign-in fails with 403                    | `BETTER_AUTH_URL` vs the request `Origin` (the api app's URL must match) and `TRUSTED_ORIGINS` (must include the dashboard and admin apps' URLs).                                                                                   |
| Verification link lands on the wrong host | `NEXT_PUBLIC_DASHBOARD_URL` (the callback URL is built from it on the server).                                                                                                                                                      |
| Dashboard shows a 500 on `/sign-in`       | The callback-URL helper falls back to `NEXT_PUBLIC_DASHBOARD_URL` during SSR — check it is set.                                                                                                                                     |
| CI fails on a fresh checkout              | `pnpm db:generate` and `pnpm sdk:build` run before typecheck/lint/test (the Prisma client and the SDK bundle are both gitignored).                                                                                                  |
