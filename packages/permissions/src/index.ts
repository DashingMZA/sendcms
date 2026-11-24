// packages/permissions/src/index.ts
// Barrel re-export so `@sendcms/permissions` remains the single import path.
// The site-level rules (./site) were removed with the comment system;
// only platform-level rules remain.

export * from "./platform"
export { getEffectiveRole, requireAdmin, type AdminActor } from "./admin"
