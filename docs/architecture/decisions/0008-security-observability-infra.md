# ADR 0008 — Security, observability, and Cloudflare infrastructure (Phase 10)

Status: Accepted (2026-11-18)

## Context

Phase 10 of the monorepo migration (audit §10): `packages/security`,
`packages/observability`, `infrastructure/cloudflare`. Exit criteria:
"Headers, audit logging, structured logging wired; Cloudflare build
still green."

The recon found four real gaps:

1. **Headers:** only `apps/marketing/public/_headers` existed (nosniff /
   referrer / frame / permissions-policy + immutable `/_next/static/*`).
   No app had a `headers()` in its Next config, so the api, dashboard,
   docs, and updates apps served **no security headers at all**.
2. **Audit logging:** domains, forms, and auth each carried their own
   local `log*Audit()` try/catch wrapper (same shape, three copies).
   Submissions, inbox actions, and user actions logged nothing — even
   though the `AuditAction` / `AuditResource` enums already cover
   `SUBMISSION` and `USER`.
3. **Structured logging:** 11 server `console.log` / `console.error`
   calls, no logger. (The seed script and the dashboard's client error
   boundary keep theirs — a CLI script and a client component.)
4. **Cloudflare:** the root `wrangler.jsonc` build command built the
   root app, which hasn't existed since Phase 8 — the deploy was
   broken. No per-app deploy existed.

## Decisions

### 1. Shared headers in `packages/security` (`src/headers.mjs`)

One definition, two shapes:

- `securityHeaders()` — the Next.js `headers()` config entries,
  wired into every app's `next.config.mjs`. Covers every route the
  Next server handles, in dev and on any host.
- `renderHeadersFile()` — the Cloudflare `_headers` file text. Each
  app's `public/_headers` is generated from it (the committed files
  are the generator's output), covering static assets on Cloudflare's
  asset layer. `tests/security.test.ts` asserts the committed files
  match the generator, so the two shapes can't drift apart.

The module is plain `.mjs` on purpose: the apps' `next.config.mjs`
files import it by relative path, and plain Node (which loads the
Next config) cannot import TypeScript. A `headers.d.ts` next to it
gives TypeScript the shapes for the package barrel and the tests.

No CSP, by the existing documented decision (Next.js inlines
scripts/styles, so a CSP needs `unsafe-inline` and adds nothing).

> **Superseded (Phase 9, 2026-11-22 — Wave 12 note):** a nonce-based
> CSP is now **enforcing on all six page apps** — see
> `docs/admin-control-plane/csp.md`. The "no CSP" decision above is
> historical; it no longer describes the live posture.

### 2. One audit writer: `logAudit()` in `packages/security`

Replaces the three per-service wrappers. Signature mirrors the
`AuditLog` model (`userId?`, `action`, `resourceType`, `resourceId`,
`detail?`, `ipAddress?`). Best-effort by design — a logging failure
is reported through the observability logger and the call resolves,
never failing the request.

New coverage (no schema change — the enums already had the values):

- Inbox submission actions: status changes (single + bulk) and
  deletes log `UPDATE` / `DELETE` on `SUBMISSION`. Written after the
  transaction commits, matching the existing best-effort pattern.
- First-user platform-owner promotion: logged only when the raw
  `UPDATE` actually promotes (`$executeRaw` returns > 0 rows), as a
  system action (no `userId` — the user didn't promote themself).
- Password-reset audit now sets `userId` (the actor is the user
  themself; the old inline write omitted it, recording the reset as a
  system action).

Layered-flow note: the audit writer is the documented exception to
"only services import `@sendcms/database`" (like `packages/auth` is
for auth) — it exists so the audit write lives in one place, and it
is called only from services.

No admin UI for reading the log — out of scope (the audit §6 notes
none reads it today; Phase 10 doesn't build one).

> **Superseded (Phase 9 — Wave 12 note):** the audit-log UI exists —
> `/admin/audit-logs` in the admin app, live in production since
> 2026-11-23 — see `docs/admin-control-plane/admin-audit-trail.md`.

### 3. Structured logging in `packages/observability`

`createLogger(scope)` writes one JSON object per line
(`{ timestamp, level, scope, message, ...fields }`) to stdout
(info/warn) or stderr (error). `LOG_LEVEL` env gates the level
(`info` default). Error values are flattened to
`{ name, message, stack }` (an Error stringifies to `{}`).

Wired into the server calls: the submit route's outbox-run failure,
the submissions service's enqueue failure, the API error handler
(`handleApiError` — every unhandled API error is now a structured
line), the auth factory's promotion failure, and the email worker
(startup + shutdown + poll failures). The audit writer's failure
path logs through it too.

Deliberately left on `console`:

- **The auth mailer's dev verification-link line.** It stays a plain
  `console.log` with its exact `[auth-email]` format — the journey
  greps the dev-server log for it (step 2), and the owner reads the
  link from the log the same way. Switching it to JSON would break
  both.
- The seed script (a CLI script) and the dashboard's client error
  boundary (a client component — `console.error` is the Next
  convention there).

### 4. Session cookie domain — env-driven, unset by default

The auth factory sets `advanced.defaultCookieAttributes.domain`
from `COOKIE_DOMAIN` when the var is set, and omits it otherwise
(host-only cookies — current behavior, dev). No value is committed
anywhere: the production domain is still undecided, and the cookie
domain follows from it. Documented in `.env.example`.

### 5. Cloudflare cutover — per-app configs, api keeps `sendcms`

- `infrastructure/cloudflare/` holds the shared OpenNext config
  (R2 incremental cache, moved from the root) and the deploy README.
- Each app has its own `wrangler.jsonc` + `open-next.config.ts`
  (a one-line re-export of the shared config). The root
  `wrangler.jsonc` is deleted; the root `open-next.config.ts` moved.
- The api app keeps the worker name `sendcms` (its R2 bucket and
  self-reference keep working). The others are `sendcms-marketing`,
  `sendcms-dashboard`, `sendcms-docs`, `sendcms-updates`.
- Each app gets a `build:cf` script
  (`db:generate && sdk:build && opennextjs-cloudflare build`) and
  `@opennextjs/cloudflare` in its own devDeps. The root keeps
  `wrangler` (for `cf-typegen`, now pointed at the api app's
  wrangler) and keeps `@opennextjs/cloudflare` as a devDep too — the
  shared OpenNext config lives at the root (`infrastructure/`) and
  the root's `tsc` typechecks it, so the root needs the types.
- Public URLs in the per-app `vars` are jadoo.bond placeholders
  (`https://jadoo.bond`, `https://<app>.jadoo.bond`) until the
  production domain decision — change the vars, never the code.
  `FALLBACK_APP_URL` stays the shared placeholder for the same reason.

Known caveat (documented in `infrastructure/cloudflare/README.md`):
all five workers bind the same R2 bucket for the incremental cache,
so identical paths across apps share cache keys. The apps are
dynamic (no `revalidate` intervals), so the cache is near-empty in
practice — but if it ever matters, each app needs its own bucket.

The email worker is a long-running Node process and does not deploy
to Cloudflare Workers; its production hosting stays a separate
decision, and the cron route stays the hosted drain until then.

### 6. Deferred — admin-API rate limiting

The public submit is already DB-backed limited (per-IP 10/min +
100/hour, per-form daily cap — isolate-safe by design). The admin
REST API and auth routes have none, but a limiter is not in this
phase's exit criteria, and a wrong one locks the owner out of their
own dashboard. Recorded here as the next security item, not built.

> **Superseded (Phase 9, 2026-11-22 — Wave 12 note):** admin-API +
> auth sign-in rate limiting is **built** (admin API 600/min +
> 10,000/hour per user; sign-in 20/min per IP + 10/min per email —
> `packages/security/src/rate-limit.ts`) — see
> `docs/admin-control-plane/rate-limiting.md`, which records this as
> closing this section.

## Verification (2026-11-18)

- Root typecheck clean; `turbo run typecheck` **25/25** (23 + security
  - observability).
- Lint 0 errors / 1 pre-existing warning (the `window.location.href`
  warning in `apps/dashboard/app/dashboard/error.tsx`).
- Tests **227/227 (23 files)** — up from 218/21 (6 security + 3
  observability tests added). One real failure on the way: the first
  security-test run failed at collection — a `vi.mock` factory closed
  over a top-level `const` (hoisting); fixed with the codebase's
  `vi.hoisted` pattern.
- `pnpm build` exit 0 (**6/6 tasks**). One real finding on the way:
  the first build printed Next's "Setting a custom Cache-Control
  header can break Next.js development behavior" warning 5 times —
  the `/_next/static/*` immutable header was in `securityHeaders()`.
  Next already sets `immutable` for its static chunks in production,
  so the entry was redundant there and risky in dev; it now lives
  only in the `_headers` file (production-only asset layer). The
  rebuild has 0 such warnings.
- Cloudflare builds green for the api app + the marketing app (exit 0,
  "Worker saved in `.open-next/worker.js`" both) — the two verified;
  the other three share the identical config shape. The api build
  proves the per-app `open-next.config.ts` re-export works.
- Live journey **65/65, exit 0** (the Phase 9 checks, unchanged — the
  headers/audit/logger changes don't alter the journey's behavior;
  the cookie domain is unset in dev, so sessions behave as before).
  Journey honesty: run 1 crashed at step 2 (run from the wrong
  directory — the script reads `.dev-server-api.log` relatively —
  and left a stray test user, deleted by hand after); run 2 was
  64/65 on the known `lastRun` race (the same flake Phase 9 hit);
  run 3 was 65/65 clean, owner accounts intact (4).
