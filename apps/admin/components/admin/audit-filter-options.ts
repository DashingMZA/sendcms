// Audit explorer filter options (ADM-094) — client-safe copy.
//
// The audit-log explorer is a client component, so it cannot import
// these constants from `@sendcms/platform-ops`: the package barrel
// re-exports `./audit` (via `./service`), and `audit.ts` imports `db`
// from `@sendcms/database`, which pulls `pg` / the Prisma adapter into
// the browser bundle and breaks the production build (Turbopack:
// "Module not found: Can't resolve 'dns'/'fs'/'net'/'tls'").
//
// These arrays are therefore literal copies of the Prisma enum values
// (`AuditAction` / `AuditResource` in `packages/database/prisma/schema.prisma`).
// They must stay in sync — `tests/platform-ops.test.ts` ("audit explorer
// filter options") asserts they equal `Object.values(AuditAction)` /
// `Object.values(AuditResource)` and the service-side exports in
// `packages/modules/platform-ops/src/audit.ts`. Same pattern as the
// client-side `SYSTEM_FLAG_KEYS` copy in `features-overview.tsx`
// (ADM-092).

export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "VERIFY",
  "SUSPEND",
  "REACTIVATE",
  "PUBLISH",
  "MIGRATE",
  "CANCEL",
  "ARCHIVE",
  "ASSIGN",
  "STEP_UP_VERIFIED",
  "STEP_UP_FAILED",
] as const

export const AUDIT_RESOURCES = [
  "DOMAIN",
  "FORM",
  "SUBMISSION",
  "USER",
  "SETTINGS",
  "API_KEY",
  "PLAN",
  "SUBSCRIPTION",
  "ENTITLEMENT",
  "AI_KEY",
  "MCP_SETTINGS",
  "FEATURE_FLAG",
  "ANNOUNCEMENT",
  "DELETION_REQUEST",
  "BILLING_PROVIDER",
  "SUPPORT_TICKET",
] as const
