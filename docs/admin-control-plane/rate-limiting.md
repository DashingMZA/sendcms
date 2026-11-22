# Rate Limiting — Admin API + Auth Sign-In (Phase 9)

Closes ADR 0008 §6 ("admin-API rate limiting"). The public submit path
(10/min + 100/hour per IP) and the MCP endpoint (120/min + 2000/hour
per key) already had their own DB-backed limiters; this page covers
the two that were missing.

## Limits

All limits live in the workspace-root `config/config.json` (never
hardcoded, never `.env`):

```json
{
  "platform": { "emergency": false },
  "rateLimits": {
    "adminApi": { "perMinute": 600, "perHour": 10000 },
    "authSignIn": { "perMinutePerIp": 20, "perMinutePerEmail": 10 }
  }
}
```

| Scope        | Bucket                               | Limit                 | Why this number                                                                                                                                            |
| ------------ | ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin API    | per authenticated user (`user:<id>`) | 600/min + 10,000/hour | Anti-abuse, not a quota: a dashboard page load fires a dozen API calls. No legitimate admin trips it; a compromised account cannot hammer the API forever. |
| Auth sign-in | per IP (`ip:<ip>`)                   | 20/min                | One address hammering many accounts.                                                                                                                       |
| Auth sign-in | per email (`email:<lowercased>`)     | 10/min                | Many addresses hammering one account.                                                                                                                      |

A missing file, bad JSON, or a non-positive-integer value falls back
to the same defaults per field (`parseRateLimitConfig`, tested).

## How it works

- **One generic bucket.** `RateLimitBucket` (`scope`, `subject`,
  minute/hour window starts + counters, `@@unique([scope, subject])`)
  — migration `20261122064351_add_rate_limit_buckets`. Subjects are
  opaque strings; rows are created lazily on first use and never
  deleted (one row per subject, like `ApiKeyRateLimit` keeps one row
  per key).
- **Atomic increment.** The counter advances in a single
  `INSERT ... ON CONFLICT ("scope", "subject") DO UPDATE ...
RETURNING` statement (`@sendcms/security`, `rate-limit.ts`), so
  concurrent requests cannot overshoot the limit. This differs from
  the MCP limiter's read-then-upsert, which can overshoot by one
  under concurrency. A denied request is still counted; its window
  still expires on schedule, so the denial lifts at the same time it
  would have otherwise.
- **UTC windows.** Minute/hour starts are UTC, not local time (the
  MCP limiter uses local-time starts, which splits one wall-clock
  minute into two buckets when servers run in different timezones).
- **Fail-open, always.** Any limiter error (DB down, bad SQL,
  unexpected row) is logged through `@sendcms/observability` and the
  request is allowed — a broken limiter must never lock the owner out
  of their own admin (ADR 0008's explicit warning).

## Wiring

- **Admin API:** every `/api/v1/admin/*` handler calls
  `enforceAdminApiRateLimit(req, session.user.id)` (in
  `apps/api/lib/rate-limit.ts`) right after its session check, before
  the service call. The helper returns a `429` response with a
  `Retry-After` header when limited, `null` otherwise. Unauthenticated
  callers 401 before the check, so the per-user bucket is the one
  that matters; the helper falls back to the client IP when no user
  is known. (The admin overview route,
  `apps/api/app/api/v1/admin/overview/route.ts`, was uncommitted
  Phase 9 work when this landed — it still needs the same two lines.)
- **Auth:** `POST /api/auth/sign-in/email` only, in
  `apps/api/app/api/auth/[...all]/route.ts` before the Better Auth
  handler runs. The email is read from a cloned body so the handler
  still sees the original request; an unparsable body still gets the
  IP bucket. GETs (OAuth callbacks, session reads) and other auth
  endpoints (sign-up, password reset) are not limited.
- **Not limited here:** the public submit path and the MCP endpoint
  keep their own limiters; the cron route and the email worker are
  not user-facing.

## Layering

The counting lives in `@sendcms/security` (`rate-limit.ts`), next to
`logAudit` — the same documented exception to "only services import
`@sendcms/database`". The module is framework-agnostic (no Next.js
imports): it takes plain strings and returns
`{ allowed, retryAfterSeconds?, minuteCount, hourCount }`. The route
helper in `apps/api/lib/rate-limit.ts` is the only Next.js-aware
piece (IP extraction, 429 response). `ApiError` gained no header
support — the helper returns the 429 `NextResponse` directly, which
is also how the codebase's validation early-returns work.

## Tests

`tests/admin-rate-limit.test.ts` (18 tests, mocked Prisma with a
fake that mirrors the upsert's semantics): window rollover
(minute + hour), 429 over each limit with a `Retry-After` inside the
window, fail-open on DB error, per-user vs per-IP keying, auth
per-IP + per-email keying (including email normalization and the
IP-denied path skipping the email bucket), config parsing + the
committed file's values.
