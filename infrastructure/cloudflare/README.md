# Cloudflare infrastructure (Phase 10)

SendCMS deploys as **five Cloudflare Workers** — one per Next.js app.
Each app has its own `wrangler.jsonc` + `open-next.config.ts` in its own
directory; the OpenNext R2-cache config is shared from here
(`open-next.config.ts`, re-exported by each app).

## The five workers

| App              | Worker name         | Cloudflare Root directory | Serves                                            |
| ---------------- | ------------------- | ------------------------- | ------------------------------------------------- |
| `apps/api`       | `sendcms`           | `apps/api`                | Auth handler, all `/api/*` routes, the SDK bundle |
| `apps/marketing` | `sendcms-marketing` | `apps/marketing`          | Landing, terms, SEO routes                        |
| `apps/dashboard` | `sendcms-dashboard` | `apps/dashboard`          | Dashboard + auth pages                            |
| `apps/docs`      | `sendcms-docs`      | `apps/docs`               | The user docs                                     |
| `apps/updates`   | `sendcms-updates`   | `apps/updates`            | The changelog                                     |

The api app keeps the existing `sendcms` worker name (and its R2 bucket

- self-reference), so the current deployment's bindings keep working.
  The other four are new workers.

## Deploying (owner-side, Cloudflare dashboard)

For each app, create a Workers project with:

- **Root directory:** `apps/<app>` (the build command runs there).
- **Build command:** the `build.command` in that app's `wrangler.jsonc`
  (`pnpm --filter @sendcms/database db:generate && pnpm -w run sdk:build
&& npx @opennextjs/cloudflare build`). Or run it locally first:
  `pnpm --filter @sendcms/<app> build:cf`, then `wrangler deploy`
  from the app directory.
- **Vars:** the `vars` in that app's `wrangler.jsonc`.
- **Secrets:** the list in that app's `wrangler.jsonc` comment
  (dashboard → Settings → Variables, or `wrangler secret put`).
  The marketing, docs, and updates apps need no secrets.

## Production URLs — placeholders

The `vars` in each `wrangler.jsonc` use `https://jadoo.bond` and
`https://<app>.jadoo.bond` as **placeholders**. The production domain
(jadoo.bond vs openremark.bond) and the subdomain layout are still
undecided — when they are, change the vars in the dashboard (or the
`wrangler.jsonc` files), never the code. Each app's `FALLBACK_APP_URL`
is the same shared placeholder for the same reason.

## Shared R2 bucket — known caveat

All five workers bind the same R2 bucket (`open-remark-opennext-cache`,
the legacy name — renaming needs a new bucket in the dashboard) for
the OpenNext incremental cache. The apps are dynamic (no `revalidate`
intervals; the dashboard's `revalidatePath` calls target dynamic
routes that are never cached), so the cache is near-empty in practice —
but identical paths across apps (e.g. `/` on marketing vs the
dashboard's 404) share cache keys. If the cache ever matters, give
each app its own bucket.

## What does NOT deploy here

- **The email worker** (`services/email-worker`) is a long-running Node
  process — it does not run on Cloudflare Workers. Its production
  hosting is a separate decision (a VM/VPS process, or a scheduled
  trigger); the cron route (`GET /api/cron/email-outbox`) stays the
  hosted drain until then.
- **The old `open-remark` worker** in the dashboard is the pre-SendCMS
  deployment — delete it once the `sendcms` worker is live (owner
  step, unchanged from the pre-migration deployment notes).
