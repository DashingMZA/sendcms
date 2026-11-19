/**
 * @sendcms/observability — structured logging (Phase 10).
 *
 * One logger factory: `createLogger(scope)` writes JSON lines. Used by
 * the server code that used to `console.log` / `console.error` — the
 * email worker, the API error handler, the services, the auth factory.
 * The seed script and the dashboard's client error boundary keep their
 * `console` calls (a CLI script and a client component, not server
 * logging); the auth mailer's dev verification-link line stays a plain
 * `console.log` on purpose — the journey greps the dev-server log for
 * its exact `[auth-email]` format.
 */
export { createLogger } from "./logger"
export type { LogFields, LogLevel, Logger } from "./logger"
