# Deployment

SendCMS is a Next.js 16 App Router app with PostgreSQL (Prisma) and a
vanilla-TS SDK bundle built by esbuild. It runs anywhere Next.js runs;
the two paths used so far are Vercel and Cloudflare Workers (OpenNext).
The production domain for this instance is not decided yet — nothing in
this document assumes a particular host.

## Requirements

- Node.js 24+, pnpm 12
- PostgreSQL (any hosted Postgres; the dev database is a Prisma Postgres
  instance at `db.prisma.io`)
- The environment variables below

## Environment variables

| Variable                                                            | Required               | Notes                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | yes                    | Postgres connection string. With Prisma Postgres, use `?sslmode=verify-full`.                                                                     |
| `BETTER_AUTH_SECRET`                                                | yes                    | Random 32+ char secret (`openssl rand -base64 32`). No fallback — the app refuses to start auth without it.                                       |
| `BETTER_AUTH_URL`                                                   | yes                    | Public app URL, e.g. `https://forms.example.com`.                                                                                                 |
| `NEXT_PUBLIC_APP_URL`                                               | yes                    | Same public URL; baked into SDK snippets and email links.                                                                                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                         | for Google sign-in     | Google Cloud Console → authorized redirect URI `<APP_URL>/api/auth/callback/google`.                                                              |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`                         | for GitHub sign-in     | GitHub OAuth app → callback `<APP_URL>/api/auth/callback/github`.                                                                                 |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET`                     | for Facebook sign-in   | Meta app → callback `<APP_URL>/api/auth/callback/facebook`.                                                                                       |
| `RESEND_API_KEY`                                                    | for email              | Resend API key. The app's key is separate from any key stored in the Muse connector — set it here.                                                |
| `RESEND_FROM`                                                       | with Resend            | A sending address on a **verified** Resend domain, e.g. `SendCMS <notifications@example.com>`.                                                    |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | SMTP fallback          | Used only when no Resend key is set.                                                                                                              |
| `CRON_SECRET`                                                       | yes, for email retries | Bearer token for `GET /api/cron/email-outbox`. Without it the outbox still delivers immediately on submit, but retries after an outage never run. |
| `TURNSTILE_SECRET_KEY`                                              | for Turnstile          | Cloudflare Turnstile secret. Without it, Turnstile-enabled forms answer 503.                                                                      |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`                                    | for Turnstile          | Turnstile site key (public, baked into the SDK).                                                                                                  |

Copy `.env.example` to `.env` for local development. Never commit
`.env` (it is gitignored). The seed script (`pnpm db:seed`) creates
SendCMS demo data — a verified demo user, domain, form, and sample
submissions. It is idempotent and safe to re-run; demo data only, never
run it against a production database.

## Database

```bash
pnpm install
pnpm db:generate      # regenerate the Prisma client
pnpm db:migrate       # prisma migrate deploy on a server; migrate dev locally
```

Migrations are additive. Apply with `prisma migrate deploy` — never
`db:reset` on a live database (it is destructive and requires typed
confirmation for that reason).

## Build and run

```bash
pnpm build            # prisma generate + SDK build + next build
pnpm start            # production server
```

`pnpm dev` does the same generation steps, then starts the dev server
with Turbopack. The SDK bundle (`public/forms/v1.js`) is built from
source and gitignored — never commit it, and make sure CI builds it
before testing (the CI workflow runs `pnpm db:generate` and
`pnpm sdk:build`).

## Email outbox cron

Submission notifications are delivered immediately on submit (via
`after()`), and failed deliveries are retried by the cron route:

```http
GET /api/cron/email-outbox
Authorization: Bearer <CRON_SECRET>
```

It processes up to 100 due jobs per call. Schedule it every 5 minutes.
On Vercel, add a `vercel.json` cron entry:

```json
{
  "crons": [{ "path": "/api/cron/email-outbox", "schedule": "*/5 * * * *" }]
}
```

The route needs the `Authorization` header — Vercel Cron cannot send
custom headers, so either call it from an external scheduler that can,
or front it with a small proxy that adds the header. Without the header
the route answers 401; without `CRON_SECRET` set at all it answers 503.

## Vercel notes

- Deployments here are **manual**: the Ignored Build Step is set to
  "Don't build anything", so git pushes trigger nothing. Deploy from the
  dashboard (or the agent) after a push is tested and ready.
- Set every variable above in the project settings before the first
  deploy. `NEXT_PUBLIC_APP_URL` must be the production URL or SDK
  snippets and email links will point at the wrong host.
- The `vercel.json` redirect to the old `openremark.bond` host was
  removed — there is no production domain to redirect to yet. When the
  production domain is decided, add the redirect (or a `vercel.json`
  cron entry — see above) then.

## Cloudflare notes (Phase 10 — five Workers, one per app)

- Each app deploys as its own Worker — see
  `infrastructure/cloudflare/README.md` for the table, the dashboard
  steps, and the placeholder production URLs. The api app keeps the
  worker name `sendcms`; the others are `sendcms-marketing`,
  `sendcms-dashboard`, `sendcms-docs`, `sendcms-updates`.
- The Worker entry is `.open-next/worker.js` (OpenNext adapter);
  each app's `wrangler.jsonc` holds the R2 cache bucket, the Images
  binding, and the self-reference service binding. The build command
  must be the full chain — `pnpm --filter @sendcms/database
db:generate && pnpm -w run sdk:build && npx @opennextjs/cloudflare
build` (also in each `wrangler.jsonc`'s `build.command` and as that
  app's `build:cf` script). A bare `npx @opennextjs/cloudflare build`
  bakes a stale Prisma client and a missing SDK bundle. Set the same
  command in the dashboard's Build command field; build-time values
  (`NEXT_PUBLIC_*_URL`, Google client id) must come from the dashboard
  build environment, or the built output bakes in localhost and empty
  ids.
- Security headers come from one shared definition in
  `@sendcms/security` — each app's `next.config.mjs` `headers()` plus
  that app's `public/_headers` (nosniff, referrer policy, SAMEORIGIN
  framing, no camera/mic/geolocation). There is no
  Content-Security-Policy yet — Next.js inlines scripts/styles, so a
  CSP would need `unsafe-inline` and add nothing; a real CSP is a
  separate, tested pass.
- The R2 cache bucket is still `open-remark-opennext-cache` — it is a
  real Cloudflare resource, so renaming it needs a new bucket created
  in the dashboard first; the cache can be recreated empty. All five
  workers share that one bucket (see the caveat in
  `infrastructure/cloudflare/README.md`). The next `wrangler deploy`
  of the api app creates a new `sendcms` worker; delete the old
  `open-remark` worker in the dashboard once the new one is live.
- The app needs the Node.js runtime for the dashboard proxy (the session
  lookup hits Prisma), so it is not edge-safe; keep the OpenNext
  Node.js compat flag on.
- The email worker (`services/email-worker`) does not deploy to
  Cloudflare Workers — it is a long-running Node process. Its
  production hosting is a separate decision; the cron route
  (`GET /api/cron/email-outbox`) stays the hosted drain until then.
