# ADR 0002 — Database, auth, and permissions packages

Date: 2026-11-18 (monorepo migration, Phase 4)

## Context

The app owned the whole data + auth stack at the root: `prisma/` (schema,
19 migrations, seed), `prisma.config.ts`, `generated/prisma/` (client
output), `lib/db.ts` (Prisma singleton), `lib/auth.ts` (Better Auth
instance), `lib/auth-providers.ts`, `lib/auth-client.ts`, and
`lib/permissions/` (platform roles). The future apps need the same client,
the same auth instance, and the same permission rules.

## Decision

- `packages/database` (`@sendcms/database`): schema + migrations + seed +
  `prisma.config.ts` + the client singleton, moved verbatim via `git mv`
  (history preserved). **No schema change in the move.** The generator
  output (`../generated/prisma`, relative to the schema) still resolves —
  it now lands in `packages/database/generated/prisma`. The package
  re-exports the generated client (`export *`) alongside `db`, so every
  former `@/generated/prisma/client` and `@/lib/db` import becomes one
  `@sendcms/database` import. The app's `db:*` scripts delegate via
  `pnpm --filter @sendcms/database` (so `pnpm db:generate` — which CI runs
  first — keeps working), and `db:status`/`db:reset` (`scripts/db-manager.ts`)
  invoke the package's prisma binary the same way.
- `packages/auth` (`@sendcms/auth`): the Better Auth instance as a
  factory, `createSendcmsAuth(mailer)`. The mailer callbacks
  (`sendVerificationEmail`, `sendPasswordResetEmail`) are **injected** by
  the app because the mailer lives in the app's email module (Phase 9) and
  the package must not import app code. The factory also owns the
  providers list, the `AdminSession` type, the `auth()` helper (which
  needs `next/headers`, so `next` is a peerDependency), and re-exports
  `toNextJsHandler` for the `/api/auth/[...all]` route. Two entry points:
  `@sendcms/auth` (server) and `@sendcms/auth/client` (browser client —
  kept separate so client components never pull in server code).
- `packages/permissions` (`@sendcms/permissions`): `platform.ts` +
  `index.ts` moved verbatim (dependency-free by design).
- `lib/auth.ts` stays as a **thin wrapper** (creates the instance with the
  app's mailer; re-exports `betterAuth`, `auth()`, `AdminSession`) so all
  38 existing `@/lib/auth` import sites keep working. Phase 7 (dashboard
  app split) removes the wrapper; the app will import `@sendcms/auth`
  directly.
- `better-auth` stays pinned at exactly `1.7.25` (owner decision); the
  move does not bump it even though 1.7.26 is the latest stable.
- `db:migrate` / `db:studio` / `db:seed` in the database package load the
  root `.env` explicitly (`dotenv run -f ../../.env -- ...`, via `dotenv-cli`)
  because the package runs from its own directory. If no root `.env`
  exists, dotenv-cli fails with a clear "missing env file" error instead
  of a cryptic `DATABASE_URL` error.

## Consequences

- `prisma generate` output moved with the schema; the old root
  `generated/` directory is deleted (it was gitignored build output).
  CI's `pnpm db:generate` step still works via the wrapper, but its
  comment still says `generated/prisma` — the owner fixes that comment
  when they add `feature/**` to `ci.yml` via the web UI.
- `prisma migrate deploy` was verified against the dev DB from the new
  paths (no-op: 19/19 migrations already applied) before committing.
- The `db` singleton still caches on `globalThis` (dev hot-reload safe);
  the only change is where the module lives.
