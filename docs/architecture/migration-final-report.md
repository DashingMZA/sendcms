# SendCMS monorepo migration — final report

- Branch: `feature/monorepo-architecture-migration` (14 commits, `main`
  untouched at `4fc2d17`)
- Dates: 2026-11-18 → 2026-11-19
- Plan: [architecture/migration-audit.md](migration-audit.md) (audit §10, 13 phases)
- Decisions: `docs/architecture/decisions/` (ADR 0001–0010)
- Status: **complete** — every phase done, verified, and pushed
  (Phase 13's commit is the last one on the branch). No merge, no PR
  opened — that happens only when the owner asks.

📌 **Status note (2026-11-22):** this is a historical record of the
migration as it stood on 2026-11-19 — its claims, dates, SHAs, and
counts are kept as written. What changed since: the production domain
**is decided** (`sendcms.bond`; the "still undecided" items below are
superseded), MCP and AI were built on `feature/ai` (the "design docs
only" items below are superseded — see [MCP](../mcp.md)), and the
admin control plane (including the `apps/admin` this report says was
"explicitly not created") is in progress on
`feature/admin-control-plane` (see
[../admin-control-plane/README.md](../admin-control-plane/README.md)).

## Contents

- [What the migration did](#what-the-migration-did)
- [The 13 phases](#the-13-phases)
- [Final verification (Phase 13, 2026-11-19)](#final-verification-phase-13-2026-11-19)
- [Deviations from the audit (owner decisions)](#deviations-from-the-audit-owner-decisions)
- [Deferred / not built (carried forward)](#deferred--not-built-carried-forward)
- [Open owner items (unchanged from the transformation)](#open-owner-items-unchanged-from-the-transformation)
- [How to proceed](#how-to-proceed)

## What the migration did

SendCMS went from a single-package Next.js app (306 tracked files,
~19,862 LOC, one `app/` + `lib/`) to a pnpm + Turborepo monorepo:

- **5 apps** — marketing (:3000), api (:3001), dashboard (:3002),
  docs (:3003), updates (:3004)
- **20 packages** — config, shared, api-client, sdk, content, ui,
  database, auth, permissions, email, queue, security,
  observability + 7 business modules (domains, forms, submissions,
  inbox, notifications, users, analytics)
- **1 service** — `services/email-worker` (:3005)
- **1 infrastructure folder** — `infrastructure/cloudflare/`
  (shared OpenNext config + deploy README)
- **Tests** — 23 files, 227 tests, at the root in `tests/` (owner
  decision, Phase 13 — see "Deviations")
- **Docs** — `docs/architecture/` (audit + 10 ADRs + this report),
  `docs/development/`, `docs/operations/`, updated `docs/architecture.md`
  and `docs/deployment.md`

No behavior changed. The public submit contract (`POST
/api/public/v1/submit`), the SDK bundle (`/forms/v1.js`), the auth
flows, the inbox, and the email outbox all behave exactly as before —
verified by the live journey after every phase (43/43 → 44/44 → 61/61
→ 65/65 as the apps split). The database schema never changed during
the migration: 19 migrations, all pre-existing, no new migration was
generated. No deployment was made and no production infrastructure was
touched.

## The 13 phases

| Phase                                 | Work                                                                                                                                                              | Commit (local / remote) | Gates                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Safety + audit                    | Branch protection, the audit, baseline gates recorded                                                                                                             | `71e7bdf`               | typecheck clean, lint 0 errors / 1 warning, tests 202/202, `pnpm build` + `build:cf` green                                       |
| 2 — Workspace + Turborepo             | `pnpm-workspace.yaml` globs, `turbo.json`, root scripts, lockfile regen                                                                                           | `457e157` / `ccd3e31`   | install clean, tests 202/202, build green                                                                                        |
| 3 — Shared config + UI                | `packages/config`, `packages/shared`, `packages/ui` (22 shadcn components)                                                                                        | `967b526` / `9807fa0`   | typecheck clean, lint 0/1, tests 202/202, build green                                                                            |
| 4 — Database + auth                   | `packages/database`, `packages/auth`, `packages/permissions`                                                                                                      | `de13a1b` / `a772004`   | typecheck clean, turbo 5/5, tests 202/202, build green, `migrate deploy`: 19 migrations, none pending; journey 43/43             |
| 5 — Business modules                  | 7 modules under `packages/modules/`                                                                                                                               | `ba296d0` / `d821968`   | typecheck clean, turbo 12/12, tests 202/202, build + `build:cf` green; journey 43/43 (first run 41/43, cold-server flake)        |
| 6 — SDK + API separation              | `packages/sdk`, `packages/api-client`, `apps/api` skeleton                                                                                                        | `2d6e9f2` / `6e4973f`   | typecheck clean, turbo 15/15, tests 202/202, build + `build:cf` green, api build green, `/api/health` 200; journey 43/43         |
| 7 — Dashboard app                     | `apps/dashboard` + the remaining API routes in `apps/api`                                                                                                         | `92fab34` / `3b4759b`   | typecheck clean, turbo 17/17, tests 202/202, 4 builds green; journey 44/44                                                       |
| 8 — Marketing / Docs / Updates        | `apps/marketing`, `apps/docs`, `apps/updates`; SDK bundle moves to the api app; root app deleted                                                                  | `e946ca7` / `025d976`   | typecheck clean, turbo 21/21, lint 0/1, tests 202/202, build 6/6; journey 61/61 (first run)                                      |
| 9 — Email, queue, worker              | `packages/email`, `packages/queue`, `services/email-worker`                                                                                                       | `b632e58` / `71de0e3`   | typecheck clean, turbo 23/23, tests 218/218 (21 files), build 6/6; journey 65/65 (run 3; runs 1–2 were journey-script bugs)      |
| 10 — Security / observability / infra | `packages/security`, `packages/observability`, `infrastructure/cloudflare` (per-app wrangler + open-next configs)                                                 | `de20fab` / `483249d`   | typecheck 25/25, lint 0/1, tests 227/227 (23 files), build 6/6, Cloudflare builds green (api + marketing); journey 65/65 (run 3) |
| 11 — MCP foundation                   | **Design doc only** (ADR 0009) — no code                                                                                                                          | `c35edd7` / `73960e1`   | Gates re-run, no code changed: typecheck 25/25, lint 0/1, tests 227/227                                                          |
| 12 — AI foundation                    | **Design doc only** (ADR 0010) — no code                                                                                                                          | `4bce67b` / `66b453e`   | Gates re-run, no code changed: typecheck 25/25, lint 0/1, tests 227/227                                                          |
| 13 — Verification + docs              | This report, `docs/development/`, `docs/operations/`, rewritten `docs/architecture.md`, updated `docs/deployment.md` + AGENTS.md + skill refs, final verification | (this commit)           | See "Final verification"                                                                                                         |

One commit per phase, on the feature branch only. The owner's own
commit `af55d9a` ("Modify CI workflow for branch inclusion and
comments") sits between Phases 10 and 11: it added `feature/**` to
`ci.yml` via the web UI, which is what lets CI run on this branch at
all. The first CI run on the branch (that commit) was green.

## Final verification (Phase 13, 2026-11-19)

Run on the final tree, after all doc edits (docs change nothing, but
the gates were re-run to confirm):

- Root typecheck: clean (exit 0)
- `turbo run typecheck`: **25/25**
- Lint: **0 errors, 1 warning** (the pre-existing
  `window.location.href` warning in the dashboard error page)
- Tests: **227/227 (23 files)**
- `pnpm build`: **6/6, exit 0**
- Cloudflare builds: `pnpm --filter @sendcms/api build:cf` exit 0 +
  `pnpm --filter @sendcms/marketing build:cf` exit 0 (both "Worker
  saved in `.open-next/worker.js`", dummy DATABASE_URL)
- Live journey: **65/65, exit 0, first run** (five dev servers +
  worker checks, test-user prefix `p13-`; cleanup confirmed: 0
  submissions left, owner accounts intact — 4). Full output:
  `~/workspace/journey-phase13.log`
- CI: runs on every push to this branch now (the `feature/**`
  trigger). The Phase 10, 11, and 12 pushes each triggered a run;
  the `af55d9a` run was green.
- `main` is still `4fc2d17`, untouched. Verified by `git ls-remote`
  after every push.

Honest notes on the numbers: the commit count on the branch is **14**
(verified by `git rev-list --count main..HEAD`); an earlier status
message said 15, which was a miscount. The Phase 10 journey needed 3
runs (run 1: the script was run from the wrong cwd and left a stray
test user, deleted by hand; run 2: the known `lastRun` sampling race)
and the Phase 9 journey needed 3 runs for the same race — both are
journey-script flakes, not product failures; the final runs were clean.
The Phase 5 journey's first run was 41/43 on a cold dev server and
43/43 on re-run, unchanged.

## Deviations from the audit (owner decisions)

1. **Tests stay in `tests/`** (Phase 13, 2026-11-19). The audit's
   Phase 13 row said "tests moved with code". The owner overruled it:
   one suite, one place, one command. Recorded in
   [../development/monorepo.md](../development/monorepo.md), `AGENTS.md`, and the
   `folder-structure.md` skill reference.
2. **MCP and AI are design docs only** (owner decision 2026-11-18,
   confirmed per phase 2026-11-19). ADR 0009 (MCP) and ADR 0010 (AI)
   record the designs; no `packages/mcp`, no `packages/ai`, no code.
   The MCP build is blocked on the API-keys capability (it does not
   exist); the AI build needs the per-form opt-in setting + a provider
   chosen at build time.
3. **No `apps/mcp`, no `services/ai-worker`, no `apps/admin`.** The
   audit listed them as "explicitly not created"; that stands.
4. **The production domain is still undecided** (`jadoo.bond` vs
   `openremark.bond`). All per-app `vars` use `jadoo.bond` hosts as
   placeholders; change them together when the domain is decided.

## Deferred / not built (carried forward)

- **MCP server** (ADR 0009): needs the API-keys capability first
  (models + dashboard UI + rotation), then `packages/mcp` + the
  `/api/mcp` route, then rate limiting for the endpoint.
- **AI features** (ADR 0010): needs the per-form AI opt-in setting
  (schema + dashboard UI) + a provider chosen against the privacy
  rules, then spam re-scoring, digest, form-builder, drafts — in
  that order.
- **Admin-API rate limiting** (ADR 0008): the admin REST API and the
  auth routes have no rate limiting. The public submit API is the
  only rate-limited surface.
- **Content-Security-Policy**: none yet (Next.js inlines
  scripts/styles; a real CSP is a separate, tested pass).
- **Email worker hosting**: a long-running Node process; its
  production hosting is undecided. The cron route stays the hosted
  drain until then.
- **Production domain**: undecided (see above).
- **R2 bucket rename**: the cache bucket is still
  `open-remark-opennext-cache` (a real Cloudflare resource); renaming
  needs a new bucket in the dashboard.

## Open owner items (unchanged from the transformation)

- Verify the SMTP From header with a real email through the owner's
  own SMTP.
- Upload `sendcms-verification.txt` at the root of `jadoo.cyou`
  (domain is PENDING, FILE method).
- Check the delivered Resend test emails in `zaheerinfo6@gmail.com`.
- Deployment steps from [../sendcms-final-report.md](../sendcms-final-report.md) (now five
  per-app Cloudflare projects — see
  `infrastructure/cloudflare/README.md`): build command, `wrangler
deploy`, delete the old `open-remark` worker once the new `sendcms`
  worker is live, secrets (incl. `RESEND_API_KEY`) set separately,
  `prisma migrate deploy`.
- Open `packages/sdk/test-page.html` in a real browser as the final
  SDK visual check.
- OAuth redirect URIs must point at the **api app's** URL
  (`<API_URL>/api/auth/callback/<provider>`).

## How to proceed

- **Merge / PR**: only when the owner asks. The branch is
  self-contained (14 commits on top of `main` @ `4fc2d17`); nothing
  in it depends on `main` having moved.
- **Pushing**: `~/workspace/scripts/push-sendcms.py` (Git Data API,
  one commit at a time, `BRANCH =
'feature/monorepo-architecture-migration'`, state in
  `~/workspace/.push-state-sendcms.json`). Before any push to `main`,
  restore `BRANCH = 'main'` in the script and the main state file
  (backup at `~/workspace/.push-state-sendcms-main.json`).
- **Developing**: [../development/monorepo.md](../development/monorepo.md). **Operating**:
  [../operations/runbook.md](../operations/runbook.md). **Deploying**:
  [../deployment.md](../deployment.md) + `infrastructure/cloudflare/README.md`.
