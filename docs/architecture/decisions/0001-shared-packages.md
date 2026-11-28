# ADR 0001 — Shared packages: config, shared, ui

Date: 2026-11-18 (monorepo migration, Phase 3)

## Context

The app was a single package: `components/ui/*` (shadcn primitives),
`hooks/use-mobile.ts`, and `lib/utils.ts` (`cn()` + `getBaseUrl()`) all lived
in the app and were imported via the `@/` alias. The future apps
(marketing, docs, a second dashboard) need the same primitives, the same
class-name helper, and the same TS/ESLint settings — without copying files.

## Decision

- `packages/config` (`@sendcms/config`): the shared `tsconfig/base.json`
  (everything portable from the app's tsconfig) and the shared ESLint base
  (`eslint/base.mjs`: the Next.js presets). The app's `tsconfig.json`
  extends the base and keeps only its Next plugin + `@/` paths; the app's
  `eslint.config.mjs` spreads the base and keeps its own ignores.
  `eslint-config-next` moved into `@sendcms/config`'s dependencies; the
  `eslint` binary itself stays a devDependency of the app (its `lint`
  script and its `eslint.config.mjs` both need it resolvable at the root).
- `packages/shared` (`@sendcms/shared`): framework-free helpers. First
  member: `cn()` (moved verbatim from `lib/utils.ts`, including the
  fluid-type `tailwind-merge` extension). `getBaseUrl()` stays in the app —
  it is deployment config (production URL fallback), not shared code.
- `packages/ui` (`@sendcms/ui`): the 22 shadcn primitives (moved verbatim
  via `git mv`, history preserved) plus `useIsMobile` (moved from
  `hooks/use-mobile.ts`, which only the sidebar used). The package exposes
  one barrel import: `import { Button, Card } from "@sendcms/ui"`.
  Internal cross-imports are relative; `cn` comes from `@sendcms/shared`.
- `react`/`react-dom` are `peerDependencies` of `@sendcms/ui` (one React
  per app); the ui package's other deps (`radix-ui`, `class-variance-authority`,
  `@remixicon/react`, `next-themes`, `recharts`, `sonner`) are real
  dependencies, moved out of the app where nothing else used them
  (`radix-ui`, `class-variance-authority` left the app entirely).
- The app sets `transpilePackages: ["@sendcms/shared", "@sendcms/ui"]`
  because both packages ship TypeScript source.
- `components.json` aliases now point `ui` → `packages/ui/src/components`,
  `utils` → `@sendcms/shared`, `hooks` → `packages/ui/src/hooks`, so
  `npx shadcn add` lands new components in the package.

## Consequences

- Tailwind v4 scans the whole repo (nothing gitignored), so the moved
  components' classes still compile from the app's `globals.css`. Verified
  by a class probe on the production CSS after the move (see Phase 3
  verification).
- The design tokens stay in the app (`styles/design-tokens.css`) until a
  second app needs them (Phase 8); the ui package deliberately holds no CSS.
- The root `tsconfig.json` `include` (`**/*.ts`) still covers the packages,
  so the app's `tsc --noEmit` typechecks them too; each package also has
  its own tsconfig for standalone `turbo run typecheck`.

## Wave 12 verification (2026-11-27)

- Still holds: `packages/config` (tsconfig/base.json + eslint/base.mjs),
  `cn()` in `@sendcms/shared`, `getBaseUrl()` app-local only, the 34
  components in `packages/ui` (grown from 22) + `useIsMobile`,
  `react`/`react-dom` peerDeps, `transpilePackages` in all six apps,
  the `components.json` aliases, and no CSS in the ui package.
- Superseded: the root tsconfig no longer typechecks the packages — it
  excludes `apps` and `packages` (ADR 0005 records the split; SRC-401).
  Each app/package is typechecked by its own config (`pnpm typecheck`
  runs 39/39). The design-tokens condition has also been met: tokens now
  live as per-app `styles/design-tokens.css` files in five apps (Wave 10
  UX-203), still duplicated per app rather than shared — no shared
  tokens package exists yet.
