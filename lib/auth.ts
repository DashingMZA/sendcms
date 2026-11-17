import { betterAuth as createBetterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { headers } from "next/headers"
import { db } from "@/lib/db"
import { claimPendingInvites } from "@/lib/services/membership-service"
import type { PlatformRole } from "@/lib/permissions"

/**
 * Admin auth — Better Auth 1.7.x (stable) + Google OAuth, database sessions.
 *
 * Google is the only provider for now — GitHub/Facebook + email/password
 * with verification land in Phase 2. The widget visitor flow is separate
 * (`lib/auth-widget.ts`, WIDGET_JWT_SECRET) — never conflate the secrets.
 *
 * The instance is exported as `betterAuth` (not `auth`) so the `auth()`
 * helper below keeps its name — all existing `await auth()` call sites
 * (route handlers, server components) stay unchanged.
 */
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
  },
  user: {
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
          // First user to register becomes PLATFORM_OWNER.
          // NOTE: count-then-update race (pre-existing); fix with a unique
          // partial index / transaction in Phase 2 if it ever matters.
          const ownerCount = await db.user.count({
            where: { platformRole: "PLATFORM_OWNER" },
          })
          if (ownerCount === 0) {
            await db.user.update({
              where: { id: user.id },
              data: { platformRole: "PLATFORM_OWNER" },
            })
          }
        },
      },
    },
    session: {
      create: {
        // Runs on every sign-in (a new session row is created). Claims any
        // site invites sent to this email after the account was created.
        after: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          })
          if (user?.email) {
            await claimPendingInvites(session.userId, user.email)
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
    },
    session: {
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
    },
  }
}
