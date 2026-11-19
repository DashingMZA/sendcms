import { betterAuth as createBetterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { headers } from "next/headers"
import { db } from "@sendcms/database"
import { sendPasswordResetEmail, sendVerificationEmail } from "@sendcms/email"
import { createLogger } from "@sendcms/observability"
import { logAudit } from "@sendcms/security"
import { getConfiguredOAuthProviders } from "./providers"
import type { PlatformRole } from "@sendcms/permissions"

const logger = createLogger("auth")

/**
 * Admin auth — Better Auth 1.7.x (stable), database sessions.
 *
 * Providers: Google (always), GitHub + Facebook when their client ID +
 * secret are set (see ./providers — the sign-in UI only offers
 * configured providers). Email/password with mandatory verification:
 * sign-in is blocked until the email is verified.
 *
 * How verification trust works per provider (verified in better-auth
 * 1.7.25 source): Google reports `email_verified` from its profile;
 * GitHub checks the `verified` flag of the matching address in
 * /user/emails; Facebook reports no verification, so Facebook users land
 * with `emailVerified: false` and get a verification email on sign-up
 * (`emailVerification.sendOnSignUp`) — they can sign in, but domain
 * registration / submissions (Phase 3/5) require a verified email.
 *
 * The email callbacks come from `@sendcms/email` directly (Phase 9) —
 * the auth package owns the Better Auth instance and the mailer lives
 * in the email package, so there is no injection left to wire in.
 *
 * The instance is created by `createSendcmsAuth` (not at import time) so
 * each app controls when its own instance is created. The returned
 * `betterAuth` keeps its name so the `auth()` helper below keeps its
 * name — all existing `await auth()` call sites (route handlers, server
 * components) stay unchanged.
 */
export type AdminSession = {
  user: {
    id: string
    name: string | null
    email: string
    image: string | null
    platformRole: PlatformRole
    emailVerified: boolean
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
  }
}

export function createSendcmsAuth() {
  const configuredProviders = getConfiguredOAuthProviders()

  const betterAuth = createBetterAuth({
    database: prismaAdapter(db, { provider: "postgresql" }),
    baseURL:
      process.env.BETTER_AUTH_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000",
    // Cross-app auth (Phase 7): the dashboard app's pages run on a
    // different origin than the api app that serves /api/auth/*. The
    // browser auth client posts cross-origin, so the dashboard (and any
    // other app origin) must be trusted here, or Better Auth rejects the
    // request with INVALID_ORIGIN. Comma-separated list, e.g.
    // TRUSTED_ORIGINS=http://localhost:3002 (dev) or the dashboard
    // app's public URL (production). The baseURL above is trusted
    // implicitly; this list holds the OTHER apps' origins.
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Cookie domain for the subdomain split (Phase 10): when the apps
    // run on subdomains of one domain (api.<domain>, <domain>), the
    // session cookie needs Domain=<domain> to be shared across them.
    // Unset = host-only cookies (current behavior, dev). Set via
    // COOKIE_DOMAIN in production only — never commit a value here.
    advanced: {
      defaultCookieAttributes: {
        ...(process.env.COOKIE_DOMAIN
          ? { domain: process.env.COOKIE_DOMAIN }
          : {}),
      },
    },
    // No fallback value here on purpose: Better Auth fails fast without a
    // secret instead of silently signing with an insecure default.
    secret: process.env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      ...(configuredProviders.includes("github")
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID!,
              clientSecret: process.env.GITHUB_CLIENT_SECRET!,
            },
          }
        : {}),
      ...(configuredProviders.includes("facebook")
        ? {
            facebook: {
              clientId: process.env.FACEBOOK_CLIENT_ID!,
              clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
            },
          }
        : {}),
    },
    emailAndPassword: {
      enabled: true,
      // Sign-in is refused while the email is unverified; sign-up creates
      // the account without a session and sends the verification email.
      requireEmailVerification: true,
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
      sendResetPassword: async ({ user, url }) => {
        await sendPasswordResetEmail({ user, url })
      },
      onPasswordReset: async ({ user }) => {
        // Audit the reset (best-effort — logAudit never throws). The
        // actor is the user themself, so userId is set (the old inline
        // write omitted it, recording the reset as a system action).
        await logAudit({
          userId: user.id,
          action: "UPDATE",
          resourceType: "USER",
          resourceId: user.id,
          detail: { event: "password-reset" },
        })
      },
    },
    emailVerification: {
      // Also covers OAuth sign-ups whose provider doesn't verify email
      // (Facebook): they get a verification email on registration.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24, // 24 hours
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail({ user, url })
      },
    },
    user: {
      // Email changes verify the NEW address (the verification email goes
      // to the address being added, and the change applies only after it
      // is verified).
      changeEmail: { enabled: true },
      additionalFields: {
        platformRole: {
          type: "string",
          defaultValue: "PLATFORM_USER",
          // Never settable from the client — only the server promotes users.
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // First user to register becomes PLATFORM_OWNER. Single-statement
            // conditional UPDATE: atomic, so two simultaneous first sign-ups
            // can't both promote (the old count-then-update had that race).
            // A partial unique index (migration
            // ..._single_platform_owner) backs the invariant at the DB level.
            // Promotion is best-effort — it must never fail registration.
            try {
              const promoted = await db.$executeRaw`
              UPDATE "User" SET "platformRole" = 'PLATFORM_OWNER'
              WHERE "id" = ${user.id}
              AND NOT EXISTS (
                SELECT 1 FROM "User" WHERE "platformRole" = 'PLATFORM_OWNER'
              )`
              // Audit only when the promotion actually happened (0 rows
              // when an owner already exists). A system action, so no
              // userId — the user didn't promote themself.
              if (promoted > 0) {
                await logAudit({
                  action: "UPDATE",
                  resourceType: "USER",
                  resourceId: user.id,
                  detail: { event: "platform-owner-promotion" },
                })
              }
            } catch (err) {
              logger.error("[auth] platform-owner promotion failed", {
                error: err,
              })
            }
          },
        },
      },
    },
  })

  /**
   * Server-side session helper. Keeps the existing `await auth()` call sites
   * (route handlers, server components) unchanged.
   */
  async function auth(): Promise<AdminSession | null> {
    const result = await betterAuth.api.getSession({
      headers: await headers(),
    })
    if (!result) return null
    const { user, session } = result
    return {
      user: {
        id: user.id,
        name: user.name ?? null,
        email: user.email,
        image: user.image ?? null,
        platformRole: (user.platformRole ?? "PLATFORM_USER") as PlatformRole,
        emailVerified: user.emailVerified ?? false,
      },
      session: {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
      },
    }
  }

  return { betterAuth, auth }
}
