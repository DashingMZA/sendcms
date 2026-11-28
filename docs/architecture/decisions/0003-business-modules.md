# ADR 0003 — Business modules (`packages/modules/*`)

- Status: accepted (2026-11-18, Phase 5)
- Context: the audit's Phase 5 — move the nine `lib/services/*` files with
  their validators and queries into domain modules, so each business
  capability owns its service + schemas + client hooks in one place.

> **Later changes (2026-11-27, Phase 16 Wave 12):** the module count
> grew 7 → 17. Added after Phase 5: `api-keys` (Phase 11),
> `mcp-admin` (Phase 11), `ai-settings` (Phase 12), `plans`,
> `billing`, `platform-ops`, `admin-users`, `support`, `coupons`
> and `cron` (Phase 16). The seven-package table below is the Phase 5
> snapshot; the current list is in
> `folder-structure.md`.

## Decision

Seven packages under `packages/modules/`, one per business capability
(audit §10). Each has a server service as its main entry, a `./validators`
subpath (client-safe Zod schemas) and — where the capability has dashboard
hooks — a `./queries` subpath (React Query). Server and client code stay on
separate entry points so a client component never pulls in a server module
(the queries import service _types_ only, via `import type`).

| Package                  | Contents                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `@sendcms/domains`       | domain-service + dns-verification + validators/domain + queries/domains                  |
| `@sendcms/forms`         | form-service + validators/form + queries/forms                                           |
| `@sendcms/submissions`   | public submit flow (split out of submission-service) + turnstile + validators/submission |
| `@sendcms/inbox`         | inbox half of submission-service + validators/inbox + queries/inbox                      |
| `@sendcms/notifications` | email-outbox + validators/email-jobs + queries/email-jobs                                |
| `@sendcms/users`         | user-service + validators/auth                                                           |
| `@sendcms/analytics`     | dashboard-service (overview + analytics)                                                 |

`packages/modules/*` was added to the `pnpm-workspace.yaml` globs — the
`packages/*` glob only matches direct children, so the nested modules were
invisible to pnpm until then (install failed on `@sendcms/analytics`).

## The submission-service split

`lib/services/submission-service.ts` held two modules in one file: the
public submit flow (~500 lines) and the inbox operations (~380 lines). It
was split at the "Inbox dashboard" section boundary. The inbox half needs
only `db` + `ApiError` + `getSubmissionSender`, so it is self-contained; the
submit half keeps the domain/turnstile/notification imports. Both halves
moved with `git mv` history on the submit side.

## Shared plumbing that moved with it

- `ApiError` (the class) → `@sendcms/shared` (`src/api-error.ts`).
  `lib/api/error.ts` keeps `handleApiError` (NextResponse + CORS) and
  re-exports `ApiError` — routes keep importing from `@/lib/api/error`.
- `lib/api-client.ts` (`apiFetch` + `ApiClientError`) → `@sendcms/shared`
  (framework-free; the queries import it from there).
- `lib/submission-display.ts` (`getSubmissionSender`,
  `previewSubmissionText`) → `@sendcms/shared` (pure, client-safe, used by
  the submissions/inbox/notifications/analytics modules and by inbox
  components).
- `pingDatabase` / `SystemHealth` → `@sendcms/database` (`src/health.ts`).
  A DB health ping belongs to the database package; the health route now
  imports it from `@sendcms/database`. This empties `lib/services/` fully
  without inventing a one-function module.

## Notifications injection (Phase 9 boundary)

`email-outbox` depended on two pieces of app code: `sendPlatformEmail`
(the transport, Phase 9) and the submission-notification template
(rendered with `@react-email/render`). Both are now injected, same pattern
as the auth factory (ADR 0002): `processEmailOutbox(deps, opts)` and
`sendTestSubmissionEmail(deps, userId, formId, to)` take a `NotificationDeps`
(`sendEmail` + `renderNotification`). The app builds the deps once in
`lib/email/notification-deps.ts` (renderer over the app's template) and the
cron, test-email and public-submit routes pass it in. `enqueueSubmissionNotifications`
needs no deps (it only creates jobs). Phase 9 removes the injection when
`packages/email` owns the transport + templates. The outbox tests now pass
stub deps instead of mocking the provider.

## Cross-module dependencies (acyclic)

- submissions → domains (`normalizeDomain`), notifications (`enqueue…`)
- forms → submissions (validators/form imports `HONEYPOT_FIELD` from
  validators/submission — the shared honeypot contract; the SDK keeps its
  own copy until Phase 6)
- inbox, notifications, users, analytics, domains: no module deps (only
  `@sendcms/database` + `@sendcms/shared` + zod)
- `dns-verification` and `turnstile` are exported as subpaths
  (`@sendcms/domains/dns-verification`, `@sendcms/submissions/turnstile`)
  so the service tests can mock the exact module the service imports.

## Consequences

- `lib/services/`, `lib/validators/`, `lib/queries/` are gone; `lib/` now
  holds only app plumbing (`api/`, `auth.ts`, `cors.ts`, `email/`, `content.ts`,
  `sdk-snippet.ts`, `text-converter.ts`, `utils.ts`).
- `next.config.mjs` `transpilePackages` lists all seven modules (they are
  imported as TS source).
- Gates: typecheck clean (root + `turbo run typecheck` 12/12), lint 0
  errors / 1 pre-existing warning, tests 202/202, `pnpm build` +
  `build:cf` green, live journey 43/43.
