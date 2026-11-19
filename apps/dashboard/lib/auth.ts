import { createSendcmsAuth } from "@sendcms/auth"

/**
 * Thin wrapper — the real Better Auth config lives in `packages/auth`
 * (`createSendcmsAuth`), which wires the platform mailer
 * (`@sendcms/email`) directly (Phase 9). Each Next.js app runs its own
 * server and owns its own Better Auth instance. The API app has the
 * identical wiring in its own `lib/auth.ts`; the two cannot share one
 * instance. Every import of `@/lib/auth` (`betterAuth`, `auth()`,
 * `AdminSession`) resolves to this app's instance.
 */
export const { betterAuth, auth } = createSendcmsAuth()

export type { AdminSession } from "@sendcms/auth"
