// Shared API-layer code: CORS helpers, response builders, and error
// handling used by every route — in the serving app today, in apps/api
// from Phase 7. `ApiError` itself lives in @sendcms/shared and is
// re-exported here so routes import everything API-shaped from one
// place. The typed REST client for the v1 API is a later addition;
// this package holds only the plumbing the routes already share.
export { corsHeaders, getEffectiveOrigin, normalizeOrigin } from "./cors"
export { created, methodNotAllowed, noContent, ok } from "./response"
export { ApiError, handleApiError } from "./error"
export {
  invalidDateFilterResponse,
  validationErrorMessage,
  validationErrorResponse,
} from "./validation"
export type { ValidationErrorLike } from "./validation"
