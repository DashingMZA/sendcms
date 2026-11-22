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
export {
  buildCsp,
  createCspNonce,
  cspHeaderName,
  CSP_HEADER_NAME,
  CSP_REPORT_ONLY,
  CSP_REPORT_ONLY_HEADER_NAME,
} from "./csp"
export type { CspOptions } from "./csp"
export {
  checkAdminApiRateLimit,
  checkAuthSignInRateLimit,
  checkRateLimit,
  DEFAULT_ADMIN_API_HOUR_LIMIT,
  DEFAULT_ADMIN_API_MINUTE_LIMIT,
  DEFAULT_AUTH_SIGNIN_MINUTE_PER_EMAIL_LIMIT,
  DEFAULT_AUTH_SIGNIN_MINUTE_PER_IP_LIMIT,
  DEFAULT_RATE_LIMIT_CONFIG,
  parseRateLimitConfig,
  readRateLimitConfig,
  resetRateLimitConfigCache,
} from "./rate-limit"
export type { RateLimitConfig, RateLimitResult } from "./rate-limit"
export {
  DEFAULT_STEP_UP_CONFIG,
  DEFAULT_STEP_UP_MAX_ATTEMPTS_PER_HOUR,
  DEFAULT_STEP_UP_TTL_MINUTES,
  parseStepUpConfig,
  readStepUpConfig,
  requireStepUp,
  resetStepUpConfigCache,
  verifyStepUp,
} from "./step-up"
export type { StepUpConfig, StepUpResult, StepUpSession } from "./step-up"
export { renderHeadersFile, securityHeaders } from "./headers.mjs"
