/**
 * @sendcms/security — shared security headers + audit logging (Phase 10).
 *
 * - `securityHeaders()` / `renderHeadersFile()` live in the plain-JS
 *   `./headers.mjs` (the apps' `next.config.mjs` files import it by
 *   relative path — plain Node can't import TypeScript). The `_headers`
 *   files in each app's `public/` mirror the same data.
 * - `logAudit()` is the one audit writer for the whole codebase
 *   (domains, forms, auth, inbox). Best-effort: it never throws.
 */
export { logAudit } from "./audit"
export type { AuditLogInput } from "./audit"
export { renderHeadersFile, securityHeaders } from "./headers.mjs"
