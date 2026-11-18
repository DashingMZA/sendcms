import { createSendcmsAuth } from "@sendcms/auth"
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email/auth-mailer"

/**
 * Thin wrapper — the real Better Auth config lives in `packages/auth`
 * (`createSendcmsAuth`). This file only wires in the app's mailer, because
 * the mailer lives in the app's email module (Phase 9) and the package
 * must not import app code. Every existing import of `@/lib/auth`
 * (`betterAuth`, `auth()`, `AdminSession`) keeps working unchanged.
 * Phase 7 (dashboard app split) removes this wrapper; the app will import
 * `@sendcms/auth` directly.
 */
export const { betterAuth, auth } = createSendcmsAuth({
  sendVerificationEmail,
  sendPasswordResetEmail,
})

export type { AdminSession } from "@sendcms/auth"
