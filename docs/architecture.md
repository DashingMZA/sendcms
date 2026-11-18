# Architecture Overview

SendCMS is a contact-form backend. Any website embeds a form with one
script tag; submissions go to a public REST endpoint, are validated and
spam-checked, saved durably in Postgres, queued for email notification,
and read back in a dashboard inbox. The legacy comment system (sites,
pages, comments, widget auth) still exists in the schema and in
`/api/widget/*` + `/api/v1/sites/*`, but the dashboard no longer exposes
it — its removal is a separately approved step.

## System diagram

```
┌─────────────────────────────────────────────────────────┐
│  Any Site (Astro / Next.js / Hugo / plain HTML)         │
│                                                         │
│  <script src="https://app.com/forms/v1.js">             │
│  <form data-cms-form data-form-id="...">                │
│                            │                            │
└────────────────────────────┼────────────────────────────┘
                             │ POST /api/public/v1/submit
                             ▼
┌─────────────────────────────────────────────────────────┐
│  SendCMS Server (Next.js 16 App Router)                 │
│                                                         │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ /api/public/v1/  │  │  /api/v1/    │  │ /dashboard│  │
│  │  (public submit) │  │  (admin API) │  │ (admin UI)│  │
│  └───────┬──────────┘  └──────┬───────┘  └─────┬─────┘  │
│          │                    │                │        │
│          └────────────────────┴────────────────┘        │
│                           │                             │
│                    ┌──────▼──────┐                      │
│                    │  Services   │                      │
│                    │  (lib/)     │                      │
│                    └──────┬──────┘                      │
│                           │                             │
│                    ┌──────▼──────┐                      │
│                    │   Prisma    │                      │
│                    └──────┬──────┘                      │
│                           │                             │
│                    ┌──────▼──────┐                      │
│                    │  PostgreSQL │                      │
│                    └─────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

## Request flow — visitor submits a form

```
1. forms/v1.js enhances <form data-cms-form> on the visitor's site
   (loading / success / error states, duplicate-submit guard, honeypot)
2. POST /api/public/v1/submit { userId, formId, fields, idempotencyKey? }
   → Origin must be a verified domain linked to the form (else 403)
   → Form must be active (else 403)
   → Honeypot filled → fake 201, nothing saved
   → Turnstile (if enabled): token verified, fail-closed
   → Fields validated against the form's FormField config (else 422)
   → Payload > 64 KB → 413
   → Idempotency key or identical content within 10 min → 200, same id
   → Rate limits: 10/min + 100/hour per IP, form daily limit (else 429)
   → Spam heuristics → status SPAM, else NEW
3. Durable save in one transaction: Submission + SubmissionEvent(CREATED)
   → 201 { ok, id, message, redirectUrl }
4. after(): enqueue EmailJobs (one per enabled NotificationSettings row)
   + processEmailOutbox() attempts immediate delivery
5. GET /api/cron/email-outbox (Bearer CRON_SECRET) retries failed jobs
   (backoff 1m / 5m / 15m / 1h / 4h, 5 attempts)
6. Dashboard: owner reads the submission in /dashboard/inbox
```

## Authentication — admin only

| System | Who | Mechanism | Storage |
| ------ | --- | --------- | ------- |
| Admin auth | Form owners | Better Auth 1.7.x — Google/GitHub/Facebook OAuth + email/password (verification required) → session cookie | Server session (database) |

There is no visitor auth: visitors never sign in, and the public API
takes no credentials — the `Origin` allowlist is its authorization.
(The legacy comment widget still uses Google OAuth + Widget JWTs under
`/api/widget/*`; that system is not part of SendCMS.)

Admin routes are gated by `proxy.ts` (Next middleware — named
`proxy.ts`, not `middleware.ts`; matcher: `/dashboard/:path*`). Session
lookup hits Prisma, so the proxy runs on the Node.js runtime — it is NOT
edge-safe. Verification gates domain registration and submissions, not
dashboard access. Email/password sign-in is refused while the email is
unverified; OAuth trust varies by provider (Google: profile
`email_verified`; GitHub: `/user/emails` verified flag; Facebook: none —
those users get a verification email on sign-up). First user becomes
PLATFORM_OWNER via an atomic conditional UPDATE + partial unique index
(`User_single_platform_owner_idx`).

## Layered architecture

```
Route Handler       app/api/**         thin: parse, auth, call service (≤25 lines)
     ↓
Service Layer       lib/services/      business logic, no Next.js imports
     ↓
Prisma Client       lib/db.ts          singleton, only services import it
     ↓
PostgreSQL
```

**Rule:** Route handlers never import `lib/db.ts` — they call services.
Zod schemas live in `lib/validators/` and are shared by routes and
services. Response/error helpers live in `lib/api/`.

## SDK architecture

The form SDK is a dependency-free vanilla-TS bundle (`sdk/`, built by
esbuild to `public/forms/v1.js`, ~7 KB minified):

- **Auto-enhance** — every `<form data-cms-form>` on the page; config
  resolves form data attrs > `init()` options > script tag data attrs;
  API origin resolves script `src` origin > build-time `__APP_URL__`.
- **SPA-safe** — `MutationObserver` picks up dynamically added forms;
  `astro:page-load` listener covers Astro transitions.
- **No style leakage** — the SDK only styles its own status element
  and the invisible honeypot field; host inputs are untouched.
- **Turnstile** — loaded lazily, only when a site key is configured;
  fail-closed (load failure blocks the submit).
- **No-JS fallback** — the same endpoint accepts a plain form POST and
  answers with a 303 redirect.

## Data model summary

```
User ──< Domain ──< DomainVerification
  │         │
  │         └──< FormDomain >── Form ──< FormField
  │                                  ├──< Submission ──< SubmissionEvent
  │                                  ├──< NotificationSettings
  │                                  └──< EmailJob (also ──< Submission)
  └──< AuditLog
```

- `Domain.domain` is `@unique` (normalized hostname); `Form.id` is the
  public `formId`.
- `Submission.data` is `Json` (fields vary per form); `originDomain` is
  the observed origin host, denormalized on purpose.
- `Submission.status`: NEW | READ | STARRED | ARCHIVED | SPAM.
- `EmailJob` is the notification outbox (`PENDING` → `SENT`/`FAILED`,
  with retries). Verification and password-reset emails are sent
  directly, not through the outbox.
- `DomainVerification.challenge` is a 48-char random token, shared
  across the DNS TXT / meta-tag / file methods; 7-day TTL, 10 attempts.
- `AuditLog` records domain/form/submission/user actions (best-effort,
  never blocks the action).

## Security model

See [Security](security.md). In short: Origin allowlist per form,
honeypot + Turnstile + spam heuristics, DB-backed rate limits,
idempotency + content-hash dedupe, durable save before success, email
verification gating, audit logs.

## Scaling path

| Component     | Current              | Scale-up path                                         |
| ------------- | -------------------- | ----------------------------------------------------- |
| Database      | Postgres (Prisma)    | Read replica for the inbox; partition submissions by month at very large volumes |
| Rate limiting | DB counts per IP     | Move to Redis/Upstash when the submission table grows hot |
| Email         | Resend (or SMTP)     | Provider already abstracted (`lib/email/provider.ts`); add a second provider behind the same interface |
| SDK bundle    | Single file, 7 KB    | CDN-hosted with long-lived cache headers |
| Cron          | Single route, 100/calls | Split per-form or raise the limit with the cron schedule |
