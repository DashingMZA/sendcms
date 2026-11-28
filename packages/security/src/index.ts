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
// The pure CSP helpers live in their own subpath entry
// (`@sendcms/security/csp`), not in this barrel: the barrel also
// re-exports the db-backed audit writer, rate limiter, and step-up
// helpers, and the proxies must be able to import the CSP policy
// without pulling those into their import graph.
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
  RATE_LIMIT_CONFIG_CACHE_TTL_MS,
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
  consumeStepUpVerification,
  DEFAULT_STEP_UP_CONFIG,
  DEFAULT_STEP_UP_MAX_ATTEMPTS_PER_HOUR,
  DEFAULT_STEP_UP_TTL_MINUTES,
  findStepUpVerification,
  isStepUpAction,
  parseStepUpConfig,
  pruneStepUpVerifications,
  readStepUpConfig,
  requireStepUp,
  resetStepUpConfigCache,
  STEP_UP_ACTIONS,
  STEP_UP_CONFIG_CACHE_TTL_MS,
  verifyStepUp,
} from "./step-up"
export type {
  StepUpAction,
  StepUpConfig,
  StepUpResult,
  StepUpSession,
  StepUpVerificationRow,
} from "./step-up"
export { renderHeadersFile, securityHeaders } from "./headers.mjs"
