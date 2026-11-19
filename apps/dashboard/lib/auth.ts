import { createSendcmsAuth } from "@sendcms/auth"
import { sendPasswordResetEmail, sendVerificationEmail } from "@sendcms/email"

/**
 * Thin wrapper — the real Better Auth config lives in `packages/auth`
 * (`createSendcmsAuth`). This file only wires in the platform mailer
 * (`@sendcms/email`), because each Next.js app runs its own server and
 * owns its own Better Auth instance. The API app has the identical
 * wiring in its own `lib/auth.ts`; the two cannot share one instance.
 * Every import of `@/lib/auth` (`betterAuth`, `auth()`, `AdminSession`)
 * resolves to this app's instance.
 */
export const { betterAuth, auth } = createSendcmsAuth({
  sendVerificationEmail,
  sendPasswordResetEmail,
})

export type { AdminSession } from "@sendcms/auth"
