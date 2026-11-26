# ADR 0007 — Email, queue, worker (Phase 9)

## Status

Accepted — 2026-11-18 (Phase 9, commit pending).

## Context

Phases 4–5 left two injections in place because the email transport and
templates lived in the app:

- `createSendcmsAuth(mailer)` — the Better Auth factory took the auth
  mailer (verification / password-reset callbacks) as a parameter, and
  each app's `lib/auth.ts` passed it in.
- `processEmailOutbox(deps)` / `sendTestSubmissionEmail(deps, …)` — the
  notifications module took `NotificationDeps` (`sendEmail` +
  `renderNotification`) as a parameter, and the cron route, the submit
  route's `after()` hook, and the test-email route passed it in.

The audit (§9–§10) calls for Phase 9 to remove both injections and to
add `packages/queue` (an abstraction over the DB outbox) plus
`services/email-worker` (a standalone worker host). Exit criteria:
outbox retries + cron behavior unchanged; the worker has a real entry
point, health, and graceful shutdown.

## Decision

### 1. `packages/queue` — a concrete outbox abstraction

`@sendcms/queue` owns the EmailJob claim and retry state machine:

- `enqueueEmailJobs(jobs)` — `createMany`.
- `claimDueEmailJobs(limit)` — due PENDING jobs, oldest first, limit
  clamped to 1..100.
- `claimEmailJob(id)` — the atomic PENDING → SENDING flip; only the
  processor that wins the flip owns the job.
- `loadEmailJob(id)` — the job with the form + submission the renderer
  needs.
- `markEmailJobSent(id, messageId)` / `markEmailJobFailed(id, { error,
attempts, terminal })` — SENT, or PENDING with the 1m/5m/15m/1h/4h
  backoff (`nextAttemptDelayMs`, `MAX_EMAIL_ATTEMPTS = 6` — five
  retries, terminal only after attempt 6, so the 4 h rung fires); only
  terminal failures (out of attempts, or the submission/form is gone)
  become FAILED.

It is deliberately a concrete outbox abstraction, not a generic
`Queue<T>` interface: there is only one queue, and a generic interface
with one implementation would be the fake abstraction the brief warns
against. A second queue type is the point where this gets generalized.

### 2. Both injections removed by direct import

- The notifications module imports `notificationDeps` from
  `@sendcms/email` directly. `processEmailOutbox({ limit })` and
  `sendTestSubmissionEmail(userId, formId, to)` take no deps parameter.
- The auth factory imports `sendVerificationEmail` /
  `sendPasswordResetEmail` from `@sendcms/email` directly.
  `createSendcmsAuth()` takes no arguments, and the `AuthMailer` type
  is deleted. Each app's `lib/auth.ts` is now a one-liner:
  `export const { betterAuth, auth } = createSendcmsAuth()`.
- The contract types (`NotificationDeps`, `SubmissionNotificationProps`,
  `SubmissionNotificationField`, `NotificationEmailSender`,
  `NotificationRenderer`) moved from the notifications module into
  `packages/email/src/notification-types.ts`, so the dependency runs one
  way (notifications → email). The template's local `Props` type was the
  same shape — it imports the shared type now instead of redefining it.
  The notifications module re-exports the types so existing
  `@sendcms/notifications` importers keep working.
- `@sendcms/email` no longer depends on `@sendcms/notifications`
  (the only edge was the type import, now gone).

### 3. `services/email-worker` — a standalone Node process

`@sendcms/email-worker` drains the outbox on a timer — the alternative
to the cron HTTP trigger for deployments that run a long-lived process.

- `createEmailWorker({ port, pollIntervalMs, batchLimit })` returns
  `{ start, stop, runOnce, getHealth, getPort }`, so the loop, the
  health endpoint, and shutdown are unit-testable (see
  `tests/email-worker.test.ts`).
- Health: `GET /health` on `WORKER_PORT` (default 3005 — the next free
  dev port after updates' 3004) returns `{ status, uptimeSeconds,
polling, lastRunAt, lastRun, lastError }`. Other paths 404.
- Poll interval: `WORKER_POLL_INTERVAL_MS`, default 30_000. The worker
  polls once immediately on start (drain any backlog), then on the
  interval. A poll already in flight is not re-entered.
- Graceful shutdown: on SIGTERM/SIGINT it stops the timer, waits for
  the in-flight poll to finish (a claimed job must be marked
  sent/failed, never left SENDING), then closes the health server and
  exits 0. A failed poll (DB down, provider down) is logged, surfaced
  on the health endpoint, and never kills the worker.
- The entry (`src/index.ts`) soft-loads the workspace root `.env` when
  present (dev convenience); production sets env vars directly. A
  missing file is not an error.
- The worker joins `turbo run dev` (it has a `dev` script: `tsx watch
src/index.ts`), so `pnpm dev` starts it alongside the five apps.

### 4. The cron route stays as-is

`GET /api/cron/email-outbox` is unchanged (Bearer `CRON_SECRET`, 503
without it, limit 100). The worker is an additional drain, not a
replacement — the PENDING → SENDING claim makes the two safe to run
together. The submit route's `after()` hook still attempts delivery
immediately (limit 25).

### 5. The notification inbox link now points at the dashboard app

The notifications service built the inbox URL from
`NEXT_PUBLIC_APP_URL`, which is the marketing app's URL since Phase 8 —
the link 404s. It now reads `NEXT_PUBLIC_DASHBOARD_URL` (dev
`http://localhost:3002`), falling back to the app URL for single-app
deployments. The api app needs `NEXT_PUBLIC_DASHBOARD_URL` in its env
for the links to resolve (documented in `.env.example`).

## Consequences

- No injected deps remain in the codebase: the auth factory and the
  outbox processor both import their email path from `@sendcms/email`.
- The outbox tests mock `@sendcms/email` instead of passing stub deps;
  the submit-route test asserts `processEmailOutbox` is called with
  `{ limit: 25 }` only.
- New tests: `tests/queue.test.ts` (backoff schedule, claim, mark
  sent/failed incl. truncation) and `tests/email-worker.test.ts`
  (poll loop, health endpoint, graceful stop, failed poll).
- The user doc `docs/email-notifications.md` gained a "Standalone
  worker" section; `.env.example` documents `WORKER_PORT` +
  `WORKER_POLL_INTERVAL_MS`.
- Known cosmetic issue (pre-existing, Phase 8): `pnpm build` prints a
  turbo warning — "no output files found for task
  `@sendcms/sdk#build`" — because the SDK bundle lives in
  `apps/api/public/forms/` (outside the SDK package), so turbo's
  `build` outputs (`.next/**`, `dist/**`) don't cover it. The build
  passes (exit 0); only the SDK build's caching is affected. A proper
  fix (per-package outputs, or moving the bundle output) is a Phase 10
  packaging note — not attempted here, since the `sdk:build` task in
  `turbo.json` is the root script's config and `turbo run sdk:build`
  runs zero tasks.
- The `types` field lesson: TypeScript does not auto-include
  `@types/node` for nested workspace packages (pnpm's isolated
  `node_modules` breaks the walk-up), even when the package is in the
  package's own `node_modules/@types`. The email package's standalone
  typecheck failed on `process` until `"types": ["node", "react",
"nodemailer"]` was added to its tsconfig — the transitive pull via
  `@sendcms/notifications` → `@sendcms/database` → `pg` had been
  masking it. The notifications module (`["node", "react"]`) and the
  worker (`["node"]`) got the same explicit field. Packages that use
  `process` or Node APIs must declare their `@types/node` (and list it
  in `types`) — do not rely on a transitive pull.

## Verification (2026-11-18)

- Root typecheck clean; `turbo run typecheck` 23/23 (21 + queue +
  worker).
- Lint 0 errors / 1 pre-existing warning (the `window.location.href`
  warning in `apps/dashboard/app/dashboard/error.tsx`).
- Tests 218/218 (21 files; was 202 — queue + worker tests added, the
  duplicated backoff describe moved from `tests/email-outbox.test.ts`
  to `tests/queue.test.ts`).
- `pnpm build` exit 0 (2m18s, 6/6 tasks) — the only output is the
  pre-existing turbo warning about `@sendcms/sdk#build` outputs (see
  the known-issue note below).
- Live journey **65/65 checks passed, exit 0** (log
  `~/workspace/journey-phase9.log`): the 61 Phase 8 checks plus 4 new
  worker checks — the worker starts (spawned by the journey with a 2s
  poll interval), `GET /health` returns 200 with `status: "ok"` and
  `polling: true`, it claims and attempts a forced-due job (attempts
  2 → 3, stays PENDING — the send fails honestly with no provider
  configured), and it exits 0 on SIGTERM. Cleanup confirmed: 0
  submissions left, owner accounts intact (4).
- Journey honesty note: the first two runs were 64/65. Both failures
  were in the journey script, not the worker code — run 1 sent SIGTERM
  to the `pnpm` wrapper (not forwarded to the worker; verified by hand
  that the worker itself exits cleanly in ~1s), run 2 read `lastRun`
  after a later empty poll had overwritten the run that processed the
  job. Both were fixed in the script (spawn `tsx` directly; sample
  `/health` while waiting for the DB change) and the third run was
  clean.
