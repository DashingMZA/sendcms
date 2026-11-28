# Production deployment checklist (DOC-048)

Deploys are **manual only** — the Ignored Build Step ("Don't build
anything") cancels every git-triggered deploy, so nothing self-heals
and no deploy happens unless a human does it, project by project.
This checklist is the only control against a partial release. Follow
it in order, tick every project, and do not call a round done until
the sign-off table below is 6/6 on the same commit.

## Why this checklist exists (LVE-001)

The redeploy round of 2026-11-23 covered **4 of 6** projects
(marketing, api, dashboard, admin on `331cc73`) and silently missed
docs + updates, which stayed on `857a212` — 12 commits behind — with
nothing to catch the miss. The missing commits included the
session-aware roots, the branded api 404, the language switcher,
both CSP fixes, the dashboard i18n, and the validation messages.
The round was declared done because no checklist named all six
projects. **This checklist names them, and the round is not done
until all six rows are ticked.**

## 0. Before you start

- [ ] Branch is **`feature/admin-control-plane`** — the live branch.
      Do **not** deploy `feature/ai` (the old live branch) or `main`
      (unrelated history; HEAD `4fc2d17` is not production). If the
      branch ever changes, update this checklist and
      [Deployment](../deployment.md) in the same commit.
- [ ] Record the HEAD commit you are deploying: `git rev-parse HEAD`
      → `________________` (full SHA). Every project below must end on
      this SHA.
- [ ] Gates are green on that commit: `pnpm typecheck`, `pnpm lint`,
      `pnpm test`, `pnpm build` (see [AGENTS.md](../../AGENTS.md)).
      Never deploy a commit that has not passed the gates.
- [ ] Note any new migrations since the last deploy round
      (`git log --oneline -- packages/database/prisma/migrations`).
      If there are none, say so in the round record — do not skip the
      migrate step silently.

## 1. Migrate the production database first

- [ ] Run `pnpm db:migrate:deploy` against the **production**
      `DATABASE_URL` and confirm it applies cleanly. New code must
      never run against an unmigrated database.
- [ ] Never `db:reset` on a live database. Before any destructive
      migration (`DROP TABLE` / `DROP COLUMN`), follow the pre-migration
      backup checklist in the
      [runbook](runbook.md#database-backup-migrations-and-rollback).

## 2. Redeploy, in this order, one project at a time

Order rationale: api first (auth handler, migrations, SDK bundle),
then the apps that sign in through it (dashboard, admin), then the
public content apps (marketing, docs, updates). Any order works as
long as **all six** are done — completeness matters more than order.

For each project: Vercel dashboard → the project → Deployments →
find the deployment for the HEAD commit (branch
`feature/admin-control-plane`) → **Redeploy** → wait for `READY`.
A git-triggered deployment will show `CANCELED` (Ignored Build
Step) — that is expected; the manual redeploy is the real deploy.

| #   | Project             | Production domain                | Dashboard build command to confirm              | Smoke URL (expected)                                                                      |
| --- | ------------------- | -------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `sendcms-api`       | `https://api.sendcms.bond`       | `pnpm --filter @sendcms/api build:server`       | `https://api.sendcms.bond/api/health` → 200; `https://api.sendcms.bond/forms/v1.js` → 200 |
| 2   | `sendcms-dashboard` | `https://dashboard.sendcms.bond` | `pnpm --filter @sendcms/dashboard build:server` | `https://dashboard.sendcms.bond/sign-in` → 200                                            |
| 3   | `sendcms-admin`     | `https://admin.sendcms.bond`     | `pnpm --filter @sendcms/admin build:server`     | `https://admin.sendcms.bond/` → 200 (landing page)                                        |
| 4   | `sendcms`           | `https://sendcms.bond`           | `pnpm --filter @sendcms/marketing build:server` | `https://sendcms.bond/` → 200                                                             |
| 5   | `sendcms-docs`      | `https://docs.sendcms.bond`      | `pnpm --filter @sendcms/docs build:server`      | `https://docs.sendcms.bond/docs` → 200                                                    |
| 6   | `sendcms-updates`   | `https://updates.sendcms.bond`   | `pnpm --filter @sendcms/updates build:server`   | `https://updates.sendcms.bond/changelog` → 200                                            |

Dashboard eyeballs (not verifiable from the repo — check them
while you are in the dashboard):

- [ ] Each project's **Build Command** matches the table above.
      Marketing was the exception: it long used plain `build` and was
      corrected to `build:server` (LVE-005) — confirm the dashboard
      value, not just the doc.
- [ ] Each project's **Ignored Build Step** is still "Don't build
      anything" (manual-only deploys). If it is ever removed, git
      pushes start deploying — that is a deliberate decision, not an
      accident.
- [ ] Each project's **Root Directory** is `apps/<app>` and the
      **Framework Preset** is Next.js.

## 3. Verify every project serves the same commit (the LVE-001 guard)

This step is **mandatory** and is what the 2026-11-23 round lacked.
Do it after all six redeploys, not after each one.

- [ ] For each project, open its production deployment in the
      dashboard (or `list_deployments` via the Vercel connector) and
      confirm **live SHA == HEAD SHA** from step 0. Record the
      deployment ID per project in the sign-off table.
- [ ] Re-run every smoke URL in the table above and confirm the
      expected status. A `READY` deployment serving the wrong commit
      still fails this step.
- [ ] Confirm the cron is scheduled: the api project's Cron Jobs
      show `GET /api/cron/email-outbox` at `0 0 * * *` (once daily,
      midnight UTC — the Hobby plan allows one cron per day; see
      [Deployment](../deployment.md#email-outbox-cron)).

### Sign-off (copy per round)

| Project             | Live SHA | Deployment ID | Smoke | Tick |
| ------------------- | -------- | ------------- | ----- | ---- |
| `sendcms-api`       |          |               |       | ☐    |
| `sendcms-dashboard` |          |               |       | ☐    |
| `sendcms-admin`     |          |               |       | ☐    |
| `sendcms`           |          |               |       | ☐    |
| `sendcms-docs`      |          |               |       | ☐    |
| `sendcms-updates`   |          |               |       | ☐    |

**6/6 ticked, all on the same SHA, or the round is not done.** If
any project is behind, redeploy that project and re-verify — do not
declare the release complete with a straggler.

## 4. Record the round

- [ ] Update the live-commit table in
      [live-sites-audit.md](../production-readiness/live-sites-audit.md)
      (§1) with the new HEAD SHA, the date, and the per-project
      deployment IDs. The table is the canonical "what is live" record;
      the next audit reads it instead of relying on memory.
- [ ] If a smoke check fails, follow the
      [rollback procedure](../deployment.md#rollback) — do not push a
      hurried fix on top of a broken production deploy.

## 5. Owner-side items this checklist does not complete

These need a dashboard/DNS action by the owner and are tracked
here so they are not forgotten:

- [ ] **LVE-001 (still open at Wave 12):** docs + updates are live
      on `857a212` (last verified 2026-11-23), behind HEAD. The next
      redeploy round deploys the **current** HEAD to all six projects —
      not the stale `331cc73` the finding names.
- [ ] **LVE-011 (still open at Wave 12):** `www.sendcms.bond`
      resolves but serves nothing (no domain, no certificate, on any
      project). Add `www.sendcms.bond` as a redirect domain on the
      marketing project (→ `https://sendcms.bond/`, 308) or decide it
      is unsupported and remove the DNS record. Verify with
      `https://www.sendcms.bond/` → 308 to the apex.
- [ ] **LVE-009 (decision open):** `render.yaml` pins the dead
      branch `feature/monorepo-architecture-migration` on all 7
      services. The pin value is an owner decision (Wave 12, Stream A
      recommendation: `feature/admin-control-plane`, the live branch) —
      do not use the Blueprint until it is decided.
- [ ] **LVE-010 (decision open):** the docs/updates bare roots
      (`https://docs.sendcms.bond/`, `https://updates.sendcms.bond/`)
      404 — redirect vs landing page is undecided (Wave 12, Stream A
      recommendation: root redirects, `/` → `/docs` and `/` →
      `/changelog`). The api 404's "Read the docs" link already points
      at `/docs` (fixed in Wave 12).
