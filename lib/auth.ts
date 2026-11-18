import { betterAuth as createBetterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { headers } from "next/headers"
import { db } from "@/lib/db"
import { getConfiguredOAuthProviders } from "@/lib/auth-providers"
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email/auth-mailer"
import type { PlatformRole } from "@/lib/permissions"

/**
 * Admin auth — Better Auth 1.7.x (stable), database sessions.
 *
 * Providers: Google (always), GitHub + Facebook when their client ID +
 * secret are set (see lib/auth-providers.ts — the sign-in UI only offers
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
 * The instance is exported as `betterAuth` (not `auth`) so the `auth()`
 * helper below keeps its name — all existing `await auth()` call sites
 * (route handlers, server components) stay unchanged.
 */
const configuredProviders = getConfiguredOAuthProviders()

export const betterAuth = createBetterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  baseURL:
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000",
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
      // Audit the reset. Best-effort: a logging failure must never break
      // the reset itself.
      try {
        await db.auditLog.create({
          data: {
            action: "UPDATE",
            resourceType: "USER",
            resourceId: user.id,
            detail: { event: "password-reset" },
          },
        })
      } catch (err) {
        console.error("[auth] audit log for password reset failed:", err)
      }
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
            await db.$executeRaw`
              UPDATE "User" SET "platformRole" = 'PLATFORM_OWNER'
              WHERE "id" = ${user.id}
              AND NOT EXISTS (
                SELECT 1 FROM "User" WHERE "platformRole" = 'PLATFORM_OWNER'
              )`
          } catch (err) {
            console.error("[auth] platform-owner promotion failed:", err)
          }
        },
      },
    },
  },
})

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

/**
 * Server-side session helper. Keeps the existing `await auth()` call sites
 * (route handlers, server components) unchanged.
 */
export async function auth(): Promise<AdminSession | null> {
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
