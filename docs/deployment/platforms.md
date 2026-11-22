# Multi-platform deployment

SendCMS runs on any host that can run Node.js. The five Next.js apps
(marketing, api, dashboard, docs, updates) plus the standalone email
worker each deploy independently — one host per app on the serverless
platforms, or all of them together in one Docker Compose stack on a
single server. Cloudflare Workers is the original path (see
`infrastructure/cloudflare/README.md`); this document covers the rest.

📌 **Production domain: `sendcms.bond`** (decided 2026-11-20).
Marketing `https://sendcms.bond`, api `https://api.sendcms.bond`,
dashboard `https://dashboard.sendcms.bond`, docs
`https://docs.sendcms.bond`, updates `https://updates.sendcms.bond`.
The `feature/ai` branch is deployed to production on all five Vercel
projects. Deploys are **manual only** (Ignored Build Step).

## Contents

- [The one rule every platform shares](#the-one-rule-every-platform-shares)
- [Build-time vs runtime variables](#build-time-vs-runtime-variables)
- [Platform × app matrix](#platform--app-matrix)
- [Vercel](#vercel)
- [Node server / Docker](#node-server--docker)
- [Render](#render)
- [Netlify](#netlify)
- [Railway](#railway)
- [What is not verified here](#what-is-not-verified-here)

## The one rule every platform shares

Each app builds with the same command, `build:server` — Prisma client
generation, then (api only) the SDK bundle build, then `next build`:

```bash
pnpm --filter @sendcms/<app> build:server
```

- marketing / docs / updates: `db:generate && next build`
- dashboard: `db:generate && next build`
- api: `db:generate && sdk:build && next build` (the SDK bundle
  `apps/api/public/forms/v1.js` is served by the api app, so the api
  build must build it — a bare `next build` leaves `/forms/v1.js` 404)

And each app starts the same way:

```bash
pnpm --filter @sendcms/<app> start -- -H 0.0.0.0 -p $PORT
```

`next start` reads `$PORT` itself, but the explicit `-H 0.0.0.0 -p`
keeps the binding visible in the platform config. The dashboard
proxy (session lookup) hits Prisma, so the apps need the Node.js
runtime — they are not edge-safe.

## Build-time vs runtime variables

`NEXT_PUBLIC_*` values are inlined into the browser bundle **at build
time** and read by the server **at runtime**. Set them in both places
on every platform: as build args / build environment before the build,
and as runtime environment variables. Changing one after a deploy
means rebuilding — a runtime-only change does not reach the browser
bundle. Secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `*_KEY`,
`*_SECRET`) are runtime-only and are never build args.

`BETTER_AUTH_SECRET` must be the **same value** on the api and
dashboard apps (they share the session cookie). `BETTER_AUTH_URL` is
the api app's public URL on every platform; `TRUSTED_ORIGINS` is the
dashboard app's public URL. Full variable table:
[Deployment](../deployment.md#environment-variables).

## Platform × app matrix

| Platform      | marketing          | api                   | dashboard                   | docs                   | updates                   | email worker                       |
| ------------- | ------------------ | --------------------- | --------------------------- | ---------------------- | ------------------------- | ---------------------------------- |
| Vercel        | project `sendcms`  | project `sendcms-api` | project `sendcms-dashboard` | project `sendcms-docs` | project `sendcms-updates` | cron route (no long-lived process) |
| Node / Docker | compose service    | compose service       | compose service             | compose service        | compose service           | compose service                    |
| Render        | Blueprint service  | Blueprint service     | Blueprint service           | Blueprint service      | Blueprint service         | Blueprint worker                   |
| Netlify       | site               | site                  | site                        | site                   | site                      | cron route (no long-lived process) |
| Railway       | Dockerfile service | Dockerfile service    | Dockerfile service          | Dockerfile service     | Dockerfile service        | Dockerfile service                 |

The email worker is a long-running Node process (`tsx
services/email-worker/src/index.ts`, `/health` on `PORT` else
`WORKER_PORT`, default 3005). It runs as a real service on Node /
Docker, Render, and Railway. Vercel and Netlify are serverless and
cannot host it — there the cron route
`GET /api/cron/email-outbox` (Bearer `CRON_SECRET`) is the outbox
drain; call it every 5 minutes from an external scheduler (Vercel Cron
cannot send the `Authorization` header, so front it with a small proxy
or use an external scheduler — see
[Deployment](../deployment.md#email-outbox-cron)).

## Vercel

One project per app (all in the same team, all linked to
`DashingMZA/sendcms`):

| Project             | Build command                                   | Output directory       | Production domain        |
| ------------------- | ----------------------------------------------- | ---------------------- | ------------------------ |
| `sendcms`           | `pnpm --filter @sendcms/marketing build`        | `apps/marketing/.next` | `sendcms.bond`           |
| `sendcms-api`       | `pnpm --filter @sendcms/api build:server`       | `apps/api/.next`       | `api.sendcms.bond`       |
| `sendcms-dashboard` | `pnpm --filter @sendcms/dashboard build:server` | `apps/dashboard/.next` | `dashboard.sendcms.bond` |
| `sendcms-docs`      | `pnpm --filter @sendcms/docs build:server`      | `apps/docs/.next`      | `docs.sendcms.bond`      |
| `sendcms-updates`   | `pnpm --filter @sendcms/updates build:server`   | `apps/updates/.next`   | `updates.sendcms.bond`   |

(The marketing project predates `build:server` and still uses plain
`next build` — marketing needs no Prisma generate, so the two are
equivalent there; switching it to `build:server` is a no-op.)

Deploys are **manual only**: the Ignored Build Step ("Don't build
anything") cancels git-triggered deploys, so pushing to `main` triggers
nothing. Deploy from the dashboard (or via the agent) when tested and
ready. The `feature/ai` branch is deployed to production on all five
projects. Set the env vars in each project's dashboard before the
first deploy — the `NEXT_PUBLIC_*_URL` vars must be that project's
siblings' public URLs (see the env table in
[Deployment](../deployment.md#environment-variables)), and `DATABASE_URL` /
`BETTER_AUTH_SECRET` / `RESEND_API_KEY` / OAuth secrets must be set
per project (they are not shared between projects). Preview
deployments are behind the team's SSO protection; custom domains are
exempt.

## Node server / Docker

`Dockerfile` (repo root, parameterized by build arg `APP`) +
`docker-compose.yml` (all 5 apps + worker + Postgres) +
`.dockerignore`.

```bash
# First run: apply the Prisma migrations to the bundled Postgres.
docker compose --profile setup run --rm migrate
# Optional demo data (verified demo user + domain + form + samples).
docker compose --profile setup run --rm seed
# Then start everything.
docker compose up -d
```

One image per service, built from the same Dockerfile with a
different `APP` arg (`@sendcms/marketing`, `@sendcms/api`,
`@sendcms/dashboard`, `@sendcms/docs`, `@sendcms/updates`,
`@sendcms/email-worker`). The build stage installs the workspace,
generates the Prisma client, and runs `build:server` for the selected
app (the worker has no build step — it runs from TypeScript source via
`tsx`, which is a production dependency of the worker package for
exactly this reason). The runner stage installs production deps only
and starts the app on `$PORT`.

The compose file's `NEXT_PUBLIC_*` defaults are the localhost URLs
(`http://localhost:3000` … `:3004`). For a public host, set them in a
`.env` file next to the compose file **before building** (build args)
— they are also passed as runtime env. `BETTER_AUTH_SECRET` and the
Postgres password default to dev-only placeholders in the compose
file; override them in production. The `migrate` / `seed` one-off
services target the Dockerfile's `builder` stage (full deps + Prisma,
no app build) so they stay fast.

Single-app image (no Compose):

```bash
docker build --build-arg APP=@sendcms/api -t sendcms-api .
docker run -e PORT=3001 -e DATABASE_URL=... -e BETTER_AUTH_SECRET=... sendcms-api
```

Note: the Dockerfile is validated statically in this repo (syntax,
paths, and the commands it runs) but the image has never been built
here — this sandbox has no Docker. The first real `docker build` is
the verification step for this path.

## Render

`render.yaml` at the repo root is the whole stack as a Blueprint:
5 web services + the email worker + managed Postgres. Create it from
the dashboard: New → Blueprint → this repo.

- ⚠️ `branch: feature/monorepo-architecture-migration` — the
  monorepo code lived there until it was merged; the file still says
  that branch. Change it to the branch you deploy from before using
  the Blueprint.
- `region: singapore` — the closest Render region to Pakistan; the
  database must stay in the same region as the services.
- `plan: free` everywhere, so the Blueprint deploys with no card.
  Free web services spin down after 15 minutes idle and free Postgres
  expires after 90 days — for always-on production, switch the web
  services to `starter` and the database to `basic-256mb`.
- The public URLs in the file are Render's default hostnames
  (`https://sendcms-<app>.onrender.com`). If Render assigns a
  different subdomain on first deploy, update the `NEXT_PUBLIC_*` /
  `BETTER_AUTH_URL` values in the dashboard to match, then redeploy
  (the browser bundle inlines the build-time values).
- `DATABASE_URL` is wired from the Blueprint Postgres (`fromDatabase`).
  `BETTER_AUTH_SECRET` and `CRON_SECRET` are generated once by Render
  (`generateValue`). Secrets marked `sync: false` are set in the
  dashboard.
- The dashboard service's `BETTER_AUTH_SECRET` is `sync: false`
  deliberately: Render generates each service's value independently,
  and the dashboard must share the api service's value — copy the api
  service's generated value into the dashboard service after first
  deploy.
- `preDeployCommand: pnpm db:migrate:deploy` on the api service runs
  migrations before traffic switches. It is a paid-plan feature — on
  a free plan, run `pnpm db:migrate:deploy` manually (with the
  production `DATABASE_URL` set) instead.

## Netlify

One site per app. Each app owns `apps/<app>/netlify.toml`:

```toml
[build]
  base = "apps/<app>"
  command = "pnpm install --frozen-lockfile && pnpm --filter @sendcms/<app> build:server"
  publish = ".next"
```

The `base` in the file is the source of truth for the site's base
directory. The build command runs from the base directory; pnpm finds
the workspace root above it. The Next.js Runtime is applied
automatically by Netlify — no plugin block is needed. Set the env vars
in each site's dashboard (Site settings → Environment variables)
**before** the first build — Netlify takes runtime variables only from
the site's settings, not from `netlify.toml`, and the `NEXT_PUBLIC_*`
values are baked in at build time.

Database: Netlify has no managed Postgres in the Blueprint sense — use
an external Postgres (Neon, Supabase, Prisma Postgres) and set its
`DATABASE_URL` on the api / dashboard sites. If a function bundle ever
fails to resolve a workspace dependency, the fallback is to add
`public-hoist-pattern[]=*` to the root `.npmrc` (not set by default —
it would change the install layout for every developer).

## Railway

Railway's `railway.json` / `railway.toml` config-as-code is deprecated
and new services cannot opt into it — do not add those files. The
supported path is the Dockerfile:

1. One Railway project, one service per app + one for the worker,
   all from this repo (⚠️ the Railway notes still name the old
   `feature/monorepo-architecture-migration` branch — use the branch
   you deploy from).
2. Keep each service's source root at the **repository root** — the
   Dockerfile needs the lockfile and the whole workspace as its build
   context.
3. Set the service variable `RAILWAY_DOCKERFILE_PATH=Dockerfile`
   (the shared Dockerfile at the repo root) and the build arg
   `APP=@sendcms/<app>` (or `@sendcms/email-worker` for the worker).
   Railway passes service variables into the Docker build when the
   Dockerfile declares them as `ARG` — the Dockerfile declares `APP`
   and all `NEXT_PUBLIC_*` vars, so set the public URLs as service
   variables **before** the first deploy (they are baked into the
   browser bundle at build time).
4. Set the health check in the dashboard (Settings → Health Check):
   `/` (marketing), `/api/health` (api), `/sign-in` (dashboard),
   `/docs` (docs), `/changelog` (updates), `/health` (worker).
5. Add a Postgres service in the project and set `DATABASE_URL` on
   the api / dashboard / worker services from it. Set
   `BETTER_AUTH_SECRET` (same value on api + dashboard),
   `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, and the OAuth / email
   secrets as service variables.

Railway injects `$PORT` and the apps bind `0.0.0.0:$PORT` (the
Dockerfile's CMD does this). The worker binds `$PORT` when set, else
`WORKER_PORT` (default 3005).

## What is not verified here

- **Docker images** have never been built in this repo's sandbox (no
  Docker here). The Dockerfile, compose file, and `.dockerignore` are
  statically validated (YAML/TOML parse, resolved anchors, every
  referenced path/script exists, `build:server` proven by a real
  build). The first `docker build` + `docker compose up` is the
  remaining verification for that path.
- **Render / Netlify / Railway live deploys** need the owner's
  accounts (none are connected here). The configs in this repo are the
  complete setup; the dashboard steps above are what the owner does
  once. Vercel is the only platform with a live deployment proven
  from this repo so far (the `feature/ai` branch on all five projects,
  at `sendcms.bond`).
- **The Cloudflare `vars` still point at `jadoo.bond` placeholders**
  for the five original apps (only the admin app's `wrangler.jsonc`
  uses `sendcms.bond`). When the Cloudflare path is next deployed,
  update them together — see
  [Deployment](../deployment.md#cloudflare-notes-phase-10--five-workers-one-per-app).
