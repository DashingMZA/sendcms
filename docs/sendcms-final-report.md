# SendCMS — final report (Phase 11, 2026-11-18)

SendCMS is the contact-form backend the brief asked for, rebuilt from the
OpenRemark comment system on branch `feat/contact-form-saas`. This report
is the factual record: what was implemented, what was removed, what was
tested, what is still open, and what deployment needs. Nothing here is
claimed live unless it was verified live.

## What was implemented

| Area | What it is |
| --- | --- |
| Auth | Better Auth 1.7.25 (email/password + Google/GitHub/Facebook OAuth, env-gated). Mandatory email verification before domain registration; password reset; change-email verifies the NEW address. First user becomes PLATFORM_OWNER via an atomic conditional UPDATE + partial unique index. Facebook never sends `email_verified`, so Facebook accounts land unverified and get a verification email. |
| Domains | Registration with normalization (lowercase, strip scheme/path/`www.`), DNS TXT verification (record `sendcms._domainkey.<domain>`) plus meta-tag and file alternatives. The challenge is 36 random bytes = 48 base64url chars, the SAME value across all three methods. 7-day TTL, 10 attempts, suspend/reactivate, delete blocked while linked to forms. DNS checks use DNS-over-HTTPS (Cloudflare, Google fallback) with an SSRF guard for the meta/file fetches. |
| Forms | CRUD, public `formId` (with the owner's public `userId`), 3 default fields (name/email/message), 10 field types, active toggle, success message, redirect URL, daily limit, honeypot + optional Turnstile, many-to-many links to VERIFIED domains only, per-form notification recipients. |
| Public submission API | `POST /api/public/v1/submit` (JSON + form-encoded + multipart). Origin allowlist (linked VERIFIED domain only), field + size validation (64 KB payload cap), sanitization, honeypot (fake 201, nothing saved), Turnstile fail-closed, spam heuristics (→ SPAM, no notification), DB-backed rate limits (10/min + 100/hour per IP, per-form daily limit), idempotency keys + 10-minute content-hash dedupe, durable Postgres save BEFORE the success response. No-JS fallback: 303 redirect to `redirectUrl` or Referer + `?cms_submitted=1`. |
| JS SDK | Vanilla TS, dependency-free, 7.1 KB minified at `public/forms/v1.js`. `<script src="…/forms/v1.js" data-user-id data-form-id>` auto-enhances `<form data-cms-form>`; per-form duplicate prevention, loading/success/error states, callbacks, MutationObserver + `astro:page-load` for SPA/Astro, programmatic `window.SendCMS.submit`, invisible Turnstile support. |
| Inbox | Tabs (all/unread/read/starred/archived/spam), search (incl. inside the JSON payload), filter by form/domain/date, detail view with field values + history timeline, mark read/unread, star, archive, mark spam, delete, bulk actions. Every query scoped by `form.ownerId`. 20 per page. |
| Notifications | Shared provider: Resend when `RESEND_API_KEY` is set, platform SMTP fallback, otherwise none. Submission notifications go through the `EmailJob` outbox (retries 1m/5m/15m/1h/4h, 5 attempts; failed jobs stay PENDING until attempts are exhausted). Immediate delivery via the submit route's `after()` hook, plus `GET /api/cron/email-outbox` (Bearer `CRON_SECRET`). Verification/reset emails send directly through the same provider. Delivery log + per-form test email in the dashboard. |
| Dashboard | Overview (counts + 14-day chart + recent submissions), Domains, Forms, Inbox, Notifications, Analytics (30-day), API & SDK (public userId, SDK snippet, REST reference — no API keys), Account Settings. No comment UI anywhere. |
| Docs | Getting started, REST API, SDK, embed guides (Astro / Next.js / Hugo / plain HTML), security, deployment, troubleshooting, email notifications, architecture, README, AGENTS.md. Landing page rebranded: Contact Forms hero, single Free $0 plan. |

## What was removed

- Comment dashboard UI: `app/dashboard/sites/`, `administration/`, `notice-board/`, `settings/`, comment charts, Product Hunt badge, site switcher, GTM.
- `vercel.json` (only held the stale openremark.vercel.app → openremark.bond redirect).
- Legacy widget demo (`components/hero-video.tsx`) from the landing page.
- **Not removed (separately approved step, still open):** the legacy comment tables (`Site`/`Page`/`Comment`/`ModerationLog`) and the `/api/widget/*` + `/api/v1/sites/*` routes still exist in schema and code. The dashboard no longer exposes them.

## Tests — 206/206 pass

19 test files. Phase 11 added 67 tests for the core DB-backed paths that
were previously live-journey-only:

- `tests/submission-service.test.ts` (18): submitForm decision tree — happy path, 404/403s, honeypot, validation, idempotency + content-hash dedupe, daily + IP rate limits, spam, 413 payload, P2002 race, Turnstile 503/422/403/pass.
- `tests/submit-route.test.ts` (13): status codes, CORS echo rules (rejected origins get none), 303 no-JS redirects, `after()` outbox trigger.
- `tests/domain-service.test.ts` (16): emailVerified gate, duplicates, 48-char challenge, same-challenge method switch, expiry, attempts, suspend/reactivate, delete-blocked.
- `tests/form-service.test.ts` (10): default fields, VERIFIED-only linking, duplicate keys, notification email normalization.
- `tests/email-outbox-process.test.ts` (10): enqueue rules (SPAM → none), claim, success, retry-pending, terminal FAILED, lost claim.

Full gate (2026-11-18): `pnpm format` clean, `pnpm typecheck` clean,
`pnpm lint` 0 errors (1 pre-existing warning in
`app/dashboard/error.tsx`), `pnpm test` 206/206, `pnpm build` SUCCESS,
`pnpm build:cf` SUCCESS (worker + SDK bundle + security headers in
`.open-next`).

## Full journey — 43/43 checks (2026-11-18)

Against the dev server + dev DB (`scripts/phase11-journey.mjs`): sign up
→ verify via the real API link → sign in → register domain (normalized,
48-char challenge) → live DNS check attempt → form → link domain →
notification recipient → static page from `docs/embed-html.md` → SDK JSON
submit 201 → no-JS POST 303 → spam submit (SPAM, no job) → inbox
list/search/read/star/archive/bulk/delete → cron 401/200, outbox retry
with no provider (jobs stay PENDING, submissions survive) → test email
502 → all 5 dashboard pages with real data → cleanup (0 submissions, 4
owner accounts intact).

## Bugs found and fixed during Phase 11

1. **New test files had type errors** (vitest passes them at runtime;
   `tsc --noEmit` does not). Zod-inferred inputs are stricter than the
   tests assumed (`method` required on domain create; `honeypotEnabled` /
   `turnstileEnabled` on form create; `required` on field create;
   `SubmitResult` is a union — the honeypot variant has no `submission`).
   Fixed in the tests; typecheck clean.
2. **`.open-next` broke lint**: after a successful `build:cf`, eslint
   traversed the generated OpenNext output and OOM-crashed (exit 2).
   Fixed by adding `.open-next/**` to `globalIgnores` in
   `eslint.config.mjs` (same treatment as the built SDK bundles).
3. **Journey script bugs (test-side, not product):** the verification
   token is a signed JWT, not a `Verification` table row — the journey
   now reads the real link from the dev server log (matching this run's
   email); the outbox attempt count is 2, not 1 (the submit route's
   `after()` hook attempts delivery immediately, then the cron retries).

## Limitations (what was NOT verified)

- **No real browser:** the SDK was verified via jsdom tests + curl
  replays of its exact payload shape, not inside a real browser. Open
  `sdk/test-page.html` in a browser as a final visual check.
- **No live deploy:** `pnpm build:cf` succeeds and the worker bundle is
  produced, but nothing was deployed to Cloudflare in this phase.
  Deployment is the owner's step (see below).
- **Email delivery through the app was not re-verified end to end:**
  Resend delivery was verified via the Resend API directly (both
  `onboarding@resend.dev` and `notifications@csofts.tech` delivered to
  zaheerinfo6@gmail.com); the app's send path is covered by unit tests
  with a stubbed fetch. The app's own `RESEND_API_KEY` must be set in the
  deployment env (the stored key cannot be read back).
- **Domain verification against a real domain** was proven in Phase 3
  and by the owner's own jadoo.bond verification; the Phase 11 journey
  seeds VERIFIED via SQL because the checker cannot verify a localhost
  host.
- **No CSP:** `public/_headers` sets nosniff / referrer / frame /
  permissions policies. A Content-Security-Policy was deliberately not
  added — Next.js inlines scripts/styles, so a CSP would need
  `unsafe-inline` and add nothing. Treat CSP as a separate tested pass.

## Deployment requirements (owner steps)

1. **Production domain (still undecided):** `jadoo.bond` (Cloudflare,
   per the 2026-11-13 decision — `NEXT_PUBLIC_APP_URL` in wrangler stays
   `https://jadoo.bond`) vs `openremark.bond` (Vercel). The SDK URL and
   all embed snippets follow from this choice.
2. **Cloudflare dashboard:** Build command must be
   `pnpm db:generate && pnpm widget:build && pnpm sdk:build && npx @opennextjs/cloudflare build`
   (also set in `wrangler.jsonc` `build.command`). Then `wrangler deploy`
   creates a NEW `sendcms` worker — delete the old `open-remark` worker
   once the new one is live.
3. **R2 bucket:** `wrangler.jsonc` still names
   `open-remark-opennext-cache` (a real Cloudflare resource). Renaming
   needs a new bucket created in the dashboard first.
4. **Secrets in the deployment env:** `DATABASE_URL`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `WIDGET_JWT_SECRET`, `RESEND_API_KEY`,
   `RESEND_FROM` (a `csofts.tech` address, e.g.
   `SendCMS <notifications@csofts.tech>`), `CRON_SECRET`. Optional:
   GitHub/Facebook OAuth, `TURNSTILE_SECRET_KEY`.
5. **Database:** run `prisma migrate deploy` (never `db:reset` on live).
   The seed (`pnpm db:seed`) is SendCMS-only demo data, idempotent.
6. **Cron:** Vercel Cron cannot send custom headers, so the
   Bearer-protected `/api/cron/email-outbox` needs an external scheduler
   (or a header-adding proxy). Without the cron, failed notifications
   retry only via the submit route's `after()` hook.
7. **Env:** `WIDGET_JWT_SECRET` is still required at build/start even
   though the widget UI is removed — the widget API routes still exist.
