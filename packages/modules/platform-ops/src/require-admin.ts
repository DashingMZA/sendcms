// Shared admin authorization for the platform-ops module.
//
// The gate itself lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module. This file
// is kept as a thin re-export so the existing `./require-admin`
// imports across platform-ops keep working unchanged.
export {
  getEffectiveRole,
  requireAdmin,
  type AdminActor,
} from "@sendcms/permissions"
export { getTargetUserOrThrow } from "@sendcms/permissions/target-user"

// Every mutating route generates one correlationId per request and
// passes it here; the audit writer uses it as the idempotency key
// (same correlationId + action + resource = one row, never two).
export type AuditOpts = {
  correlationId?: string
}
