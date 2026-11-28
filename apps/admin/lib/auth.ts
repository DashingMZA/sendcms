import { createSendcmsAuth } from "@sendcms/auth"

/**
 * Thin wrapper — the real Better Auth config lives in `packages/auth`
 * (`createSendcmsAuth`), which wires the platform mailer
 * (`@sendcms/email`) directly (Phase 9). Each Next.js app runs its own
 * server and owns its own Better Auth instance. The API and dashboard
 * apps have the identical wiring in their own `lib/auth.ts`; the three
 * cannot share one instance, so this 3-way duplication is intentional —
 * do not "fix" it by extracting a shared wrapper. Every import of
 * `@/lib/auth` (`betterAuth`, `auth()`, `AdminSession`) resolves to
 * this app's instance.
 */
export const { betterAuth, auth } = createSendcmsAuth()

export type { AdminSession } from "@sendcms/auth"
