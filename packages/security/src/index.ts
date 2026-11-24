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
  checkAuthEmailRateLimit,
  checkAuthSignInRateLimit,
  checkAuthSignUpRateLimit,
  checkRateLimit,
  checkSendReplyRateLimit,
  checkTestEmailRateLimit,
  DEFAULT_ADMIN_API_HOUR_LIMIT,
  DEFAULT_ADMIN_API_MINUTE_LIMIT,
  DEFAULT_AUTH_SIGNIN_MINUTE_PER_EMAIL_LIMIT,
  DEFAULT_AUTH_SIGNIN_MINUTE_PER_IP_LIMIT,
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_SEND_REPLY_PER_MINUTE_PER_SUBMISSION,
  DEFAULT_SEND_REPLY_PER_MINUTE_PER_USER,
  DEFAULT_TEST_EMAIL_PER_MINUTE_PER_FORM,
  DEFAULT_TEST_EMAIL_PER_MINUTE_PER_USER,
  ipMatchesCidr,
  parseRateLimitConfig,
  parseTrustedProxyList,
  readRateLimitConfig,
  resetRateLimitConfigCache,
  resolveClientIp,
} from "./rate-limit"
export type {
  AuthEmailRateLimitKind,
  RateLimitConfig,
  RateLimitResult,
} from "./rate-limit"
export { isValidBearerToken } from "./cron-auth"
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
