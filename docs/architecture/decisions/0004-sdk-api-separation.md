# ADR 0004 — SDK, API client, and API app skeleton (Phase 6)

- Status: accepted (2026-11-18, Phase 6)
- Context: the audit's Phase 6 — separate the SDK and the API layer from
  the single Next.js app: the form SDK becomes a workspace package, the
  API-layer plumbing (CORS, response/error helpers) becomes a package
  every route imports from, and the API app gets its skeleton so the 21
  routes have a home to move into (Phase 7).

## Decision

### `packages/sdk` (`@sendcms/sdk`)

`sdk/` moved verbatim via `git mv` (history preserved). It stays
independently buildable: `pnpm --filter @sendcms/sdk build` (esbuild via
`tsx build.ts`) emits the bundle to the serving app's `public/forms/`
— still the repo-root app's `public/` until the serving app moves
(Phase 7/8). The root `pnpm sdk:build` now delegates to the filter, so
`dev` / `build` / `build:cf` are unchanged. `esbuild` moved out of the
root devDependencies into the SDK package (it was the SDK's only user);
`tsx` stays at the root (db-manager scripts) and is also declared in the
SDK package (its build script runs on it).

The build script's paths are relative to its own file (`import.meta.dirname`):
env files `../../.env` + `../../.env.local`, outfiles
`../../public/forms/v1.js` + `v1.debug.js`.

The embed-snippet builders (`lib/sdk-snippet.ts`) moved with it, as
`src/snippet.ts` on a `./snippet` subpath — the snippet is the SDK's
public contract (script tag + form example + REST example), so it lives
with the SDK, not in the app. The dashboard API page and its test import
it from `@sendcms/sdk/snippet`.

### Honeypot contract unified (`@sendcms/shared/constants`)

`HONEYPOT_FIELD` (`"_sendcms_honeypot"`) was defined twice — in
`sdk/src/types.ts` and in `@sendcms/submissions` validators (ADR 0003
left the SDK's copy for Phase 6). It now lives once in
`@sendcms/shared/src/constants.ts`, exported as a `./constants` subpath
(a separate entry point so the SDK's esbuild bundle inlines only the
constant, never the shared barrel's `cn`/`clsx` graph). Both sides import
it and re-export it, so existing import sites (`@sendcms/submissions/validators`,
the SDK's `api.ts` via `./types`) are unchanged.

Bundle check: the rebuilt bundle is functionally identical to the
pre-move bundle — the debug bundle's only diff is esbuild's source-path
comments (`sdk/src/*` → `src/*`, plus the new `../shared/src/constants.ts`
header); the minified bundle is 4 bytes larger for the same reason. The
old bundle was rebuilt from a clean worktree of the Phase 5 commit to
prove the comparison (same env, same hashes as the recorded baseline).

### `packages/api-client` (`@sendcms/api-client`)

The API layer's shared code, moved verbatim via `git mv`:

| File | Contents |
| ---- | -------- |
| `src/cors.ts` | `getEffectiveOrigin`, `normalizeOrigin`, `corsHeaders` (framework-free) |
| `src/response.ts` | `ok`, `created`, `noContent` (NextResponse helpers; `next` is a peerDep + devDep, same pattern as `@sendcms/auth`) |
| `src/error.ts` | `handleApiError` + `ApiError` re-exported from `@sendcms/shared` |

All 21 routes, 3 dashboard pages, and 5 test files import from the
single barrel (`@sendcms/api-client`); the two-line imports
(`@/lib/api/response` + `@/lib/api/error`, plus `@/lib/cors` on the
submit route) collapsed into one merged import per file. `lib/api/` and
`lib/cors.ts` are gone.

The typed REST client for the v1 API was NOT built here: there is no
existing typed client to move (the dashboard queries already are the
typed client, over `apiFetch` from `@sendcms/shared`), and the brief
forbids speculative packages. It is a Phase 7+ candidate, once `apps/api`
owns the routes.

### `apps/api` skeleton (`@sendcms/api`)

A Next.js app shell that builds and serves one real route — the health
route moved here from the root app (`app/api/health/route.ts` →
`apps/api/app/api/health/route.ts`, imports updated). The other 20 routes
move in Phase 7 (audit mapping 6/7). The app runs on port 3001 in dev
(`pnpm --filter @sendcms/api dev`); it has no proxy/middleware of its
own and no SDK bundle to serve.

Two monorepo gotchas, both fixed in the skeleton (not worked around):

- `turbopack.root` must be the WORKSPACE root (`path.resolve(__dirname,
  "../..")`). With the root set to the app dir, Turbopack could not
  resolve the `next` package (pnpm symlinks point outside the app dir)
  and the build failed with "Could not find the Next.js package".
- The app needs its own `proxy.ts`. With the Turbopack root at the
  workspace root, the workspace-root `proxy.ts` (the dashboard's
  middleware, living at the repo root until Phase 7) was picked up as
  this app's proxy and failed on `@/lib/auth`. `apps/api/proxy.ts` is a
  pass-through with an empty matcher — it documents "this app has no
  middleware" and shadows the dashboard's proxy. It goes away (or gains
  a real matcher) when the API app grows its own middleware needs.

## Consequences

- `lib/` now holds only app plumbing (`auth.ts`, `email/`, `content.ts`,
  `text-converter.ts`, `utils.ts`). The `lib/api/`, `lib/cors.ts`, and
  `lib/sdk-snippet.ts` entries in ADR 0003's consequences are gone.
- `next.config.mjs` (root) `transpilePackages` gained `@sendcms/api-client`
  and `@sendcms/sdk`.
- The `turbo.json` `sdk:build` task is unchanged: it runs in the root
  package (whose script delegates to the filter) and its outputs
  (`public/forms/**`) land in the root's `public/`.
- Gates: typecheck clean (root + `turbo run typecheck` 15/15), lint 0
  errors / 1 pre-existing warning, tests 202/202, `pnpm build` +
  `build:cf` + `pnpm --filter @sendcms/api build` green, live
  `/api/health` on port 3001 returns 200 (`database: connected`), live
  journey 43/43 (first run 38/43 — the dev server had been started
  without `CRON_SECRET`, so the cron route correctly refused with 503;
  re-ran with the secret set, 43/43).
