# Email notifications (Phase 9)

When a visitor submits a form, SendCMS saves the submission first and
then queues one notification email per enabled recipient of that form
(`NotificationSettings` — one row per address, toggled on the form
detail page). Delivery runs through the `EmailJob` outbox, so a dead
mail provider delays the email, never the submission.

## Provider

One send path for all platform mail (verification, password reset,
submission notifications), in priority order:

1. **Resend** (recommended) — set `RESEND_API_KEY`. Create a key at
   https://resend.com/api-keys and verify a sending domain at
   https://resend.com/domains. Set `RESEND_FROM` to an address on
   that verified domain (e.g. `SendCMS <notifications@yourdomain.com>`).
   Resend rejects mail from unverified domains, so the From address
   is its own setting and never silently reused from SMTP.
2. **Platform SMTP** — `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
   (+ optional `SMTP_FROM`, `SMTP_PORT`). Kept from Phase 2.
3. **None** — auth mail logs the link in dev and throws in
   production; outbox jobs fail with a clear error and are retried.

No provider is needed to develop against the outbox: jobs queue and
fail honestly, which is how the outage path is tested.

## Outbox and retries

- `enqueueSubmissionNotifications()` runs after the submission
  transaction commits (inside `submitForm`, best-effort — an enqueue
  failure is logged, the submission is already safe). Spam
  submissions get no notification.
- Delivery is attempted immediately after the response is sent
  (the public submit route's `after()` hook) and retried by the cron
  worker. Each attempt flips PENDING → SENDING first, so two
  processors never send the same job twice.
- Retry backoff: 1m, 5m, 15m, 1h, 4h. After 5 attempts the job stays
  FAILED with `lastError` and no further retry — visible in the
  Notifications delivery log (`/dashboard/notifications`).
- `providerMessageId` records the Resend/SMTP message id for
  delivery tracking.

## Cron worker

`GET /api/cron/email-outbox` processes up to 100 due jobs. Auth is a
shared secret: the scheduler sends
`Authorization: Bearer <CRON_SECRET>`. Without `CRON_SECRET` the
route answers 503.

Vercel Cron (`vercel.json`, deploy target still open — see the plan):

```json
{
  "crons": [
    {
      "path": "/api/cron/email-outbox",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

Set `CRON_SECRET` in the project env vars; Vercel Cron sends the
header automatically when the cron is configured with a secret
(else call the route from any scheduler with the header).

## Standalone worker

For deployments that run a long-lived process, `services/email-worker`
drains the outbox on a timer instead of (or alongside) the cron route:

```bash
pnpm --filter @sendcms/email-worker start
```

It polls every `WORKER_POLL_INTERVAL_MS` (default 30_000), processes
up to 100 due jobs per poll, and serves a health endpoint at
`GET http://localhost:<WORKER_PORT>/health` (`WORKER_PORT`, default
3005). The health response reports `polling`, the last run's counts,
and the last error. The worker shuts down gracefully on SIGTERM/SIGINT
(it finishes the in-flight poll before exiting), and a failed poll
never kills it — the next poll retries. Running the worker and the cron
together is safe: the PENDING → SENDING claim means a job is owned by
exactly one processor. In dev, `pnpm dev` starts the worker alongside
the five apps.

## Test email

On a form's detail page (Notifications section), "Send a test
notification" sends a sample email straight through the provider —
not via the outbox, since there is no submission to render from. It
returns the provider and message id, or the provider's error.

## Failure modes

- No provider configured → the job stays PENDING with `lastError`
  set and a retry scheduled (1m, 5m, 15m, 1h, 4h). After 5 attempts
  it becomes FAILED. Fix the config, the next cron run sends it.
- Provider rejects (bad key, unverified From domain) → same, with
  the provider's message in `lastError`.
- Submission deleted before delivery → job FAILED, "Submission or
  form no longer exists", no retry (unrecoverable).
