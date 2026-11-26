import { betterAuth as createBetterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { headers } from "next/headers"
import { db } from "@sendcms/database"
import { sendPasswordResetEmail, sendVerificationEmail } from "@sendcms/email"
import { enqueueAuthEmailJob } from "@sendcms/notifications"
import { createLogger } from "@sendcms/observability"
import { logAudit, parseTrustedProxyList } from "@sendcms/security"
import { getConfiguredOAuthProviders } from "./providers"
import type { AdminRole, PlatformRole } from "@sendcms/permissions"

export type UserStatus = "ACTIVE" | "SUSPENDED" | "DISABLED"

const logger = createLogger("auth")

// Trusted reverse-proxy IPs/CIDRs for Better Auth's client-IP
// resolution (SEC-010): the same TRUSTED_PROXY_IPS list the rate
// limiter uses. Only IP/CIDR entries are passed through — the list
// may also carry the `cloudflare` token, which Better Auth does not
// understand (its cf-connecting-ip handling has no cf-ray check, so
// it is not wired here either).
function trustedProxyEntries(): string[] {
  return parseTrustedProxyList(process.env.TRUSTED_PROXY_IPS).filter(
    (entry) => /^[0-9a-f:.]+\/\d+$/.test(entry) || /^[0-9a-f:.]+$/.test(entry)
  )
}

/** Recipient locale for auth mail (EML-010): resolved from the user
    row at send time. Never throws — a missing row or preference falls
    back to English in the mailer. */
async function userLocale(userId: string): Promise<string | undefined> {
  try {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    })
    return row?.locale ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Admin auth — Better Auth 1.7.x (stable), database sessions.
 *
 * Providers: Google/GitHub/Facebook OAuth when their client ID +
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
    // Admin Control Plane (Phase 3): account status + staff role, carried
    // on the session so proxies and server components can enforce them
    // without an extra DB read. `adminRole` is null for plain customers.
    status: UserStatus
    adminRole: AdminRole | null
    emailVerified: boolean
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
  }
}

/**
 * Better Auth builds verification email links against its own mount
 * point (`<api>/api/auth/verify-email?token=…`), but the page that
 * consumes the token lives on the dashboard app at /verify-email —
 * the dashboard serves no /api/auth/* routes (only /api/v1/* is
 * rewritten to the api), so a link that keeps the /api/auth prefix
 * 404s there and the email is never verified. That breaks the
 * sign-up, resend, and change-email flows alike (adjacent discovery
 * in Wave 2, same family as SEC-001 / SEC-002 / ADM-001; corrected
 * live 2026-11-24 after the origin-only rewrite was caught 404ing).
 * Rewrite the link to the dashboard origin AND strip the /api/auth
 * mount prefix from the path; the token and callbackURL are preserved
 * untouched.
 */
export function verificationUrlOnDashboard(url: string): string {
  const dashboardOrigin =
    process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3002"
  try {
    const parsed = new URL(url)
    const dashboard = new URL(dashboardOrigin)
    parsed.protocol = dashboard.protocol
    parsed.host = dashboard.host
    if (parsed.pathname.startsWith("/api/auth/")) {
      parsed.pathname = parsed.pathname.slice("/api/auth".length)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export function createSendcmsAuth() {
  const configuredProviders = getConfiguredOAuthProviders()

  // Cross-app auth (Phase 7): the dashboard app's pages run on a
  // different origin than the api app that serves /api/auth/*. The
  // browser auth client posts cross-origin, so the dashboard (and any
  // other app origin) must be trusted here, or Better Auth rejects the
  // request with INVALID_ORIGIN. Comma-separated list, e.g.
  // TRUSTED_ORIGINS=http://localhost:3002,http://localhost:3006 (dev)
  // or the dashboard and admin apps' public URLs (production). The
  // baseURL above is trusted implicitly; this list holds the OTHER
  // apps' origins. Empty is LOUD, not silent (SEC-005): without it,
  // cross-origin auth fails at sign-in time with no hint at boot.
  const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (trustedOrigins.length === 0) {
    logger.warn(
      "[auth] TRUSTED_ORIGINS is empty — dashboard/admin origins will be refused with INVALID_ORIGIN; set it to the dashboard and admin app URLs",
      { baseURL: process.env.BETTER_AUTH_URL ?? null }
    )
  }

  const betterAuth = createBetterAuth({
    database: prismaAdapter(db, { provider: "postgresql" }),
    baseURL:
      process.env.BETTER_AUTH_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000",
    trustedOrigins,
    // Session lifetime: 30 days (Better Auth default is 7 days). The
    // session is refreshed when used after `updateAge` (default 1 day),
    // so active users stay signed in; an idle session expires 30 days
    // after its last refresh.
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
    },
    // Cookie domain for the subdomain split (Phase 10): when the apps
    // run on subdomains of one domain (api.<domain>, <domain>), the
    // session cookie needs Domain=<domain> to be shared across them.
    // Unset = host-only cookies (current behavior, dev). Set via
    // COOKIE_DOMAIN in production only — never commit a value here.
    //
    // Cookie attributes are set explicitly (SEC-321) instead of
    // relying on the library defaults: HttpOnly + SameSite=Lax
    // always; Secure only over HTTPS (production) — a Secure cookie
    // on the http dev origins would never be sent back.
    //
    // Client-IP tracking (SEC-010): Better Auth reads the IP from
    // x-forwarded-for by default; the trusted proxies are the same
    // TRUSTED_PROXY_IPS list the rate limiter uses, so a forwarded
    // chain is walked right-to-left past trusted hops only. Without
    // trusted proxies a single-value header is trusted (library
    // behaviour); multi-value chains are not. ipv6Subnet 128
    // records the full address instead of the library's /64
    // collapse — the session row is an audit record, not a
    // rate-limit key.
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        ...(process.env.COOKIE_DOMAIN
          ? { domain: process.env.COOKIE_DOMAIN }
          : {}),
      },
      ipAddress: {
        trustedProxies: trustedProxyEntries(),
        ipv6Subnet: 128,
      },
    },
    // No fallback value here on purpose: Better Auth fails fast without a
    // secret instead of silently signing with an insecure default.
    secret: process.env.BETTER_AUTH_SECRET,
    socialProviders: {
      // Every provider is gated on its credentials being set
      // (SRC-306 / DOC-020 / SEC-004): an unconfigured provider is
      // neither registered nor offered, so the sign-in button can
      // never lead to a failed OAuth attempt. No `!` assertions on
      // possibly-empty values — the credentials are read into locals
      // and only spread in when both are present.
      ...(configuredProviders.includes("google") &&
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(configuredProviders.includes("github") &&
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
      ...(configuredProviders.includes("facebook") &&
      process.env.FACEBOOK_CLIENT_ID &&
      process.env.FACEBOOK_CLIENT_SECRET
        ? {
            facebook: {
              clientId: process.env.FACEBOOK_CLIENT_ID,
              clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
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
        await sendPasswordResetEmail({
          user,
          url,
          locale: await userLocale(user.id),
          // EML-009: a provider failure leaves a durable, retryable
          // outbox job instead of vanishing — the mailer rethrows,
          // so Better Auth still reports the failure to the caller.
          onSendFailure: async (record) => {
            await enqueueAuthEmailJob({ ...record, userId: user.id })
          },
        })
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
        await sendVerificationEmail({
          user,
          url: verificationUrlOnDashboard(url),
          locale: await userLocale(user.id),
          // EML-009: see sendResetPassword above.
          onSendFailure: async (record) => {
            await enqueueAuthEmailJob({ ...record, userId: user.id })
          },
        })
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
        // Admin Control Plane (Phase 3): account status + staff role.
        // Both are server-managed only (admin actions) — never settable
        // from the client. They are carried on the session so the proxies
        // and the auth() helper can enforce suspension without an extra
        // DB read.
        status: {
          type: "string",
          defaultValue: "ACTIVE",
          input: false,
        },
        adminRole: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // SEC-003 / SEC-106 / SEC-321: a suspended or disabled user
          // must not mint a fresh session at sign-in at all. Returning
          // false makes createSession return null, and sign-in then
          // throws 401 FAILED_TO_CREATE_SESSION with no Set-Cookie —
          // no fresh credential for an account the platform
          // deliberately disabled. This covers every sign-in path
          // (email, OAuth, verify-email auto-sign-in) because they all
          // create the session through this hook. The auth() helper
          // below keeps its own status check as the second layer: a
          // row created before this hook existed still reads as
          // signed out until the account is ACTIVE again.
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            })
            if (user && user.status !== "ACTIVE") return false
          },
        },
      },
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
   *
   * Suspension enforcement (Admin Control Plane, Phase 3): a user whose
   * status is not ACTIVE gets no session here — every session-gated route
   * and server component treats them as signed out. The session row stays
   * in the DB, so reactivating/restoring the account restores access
   * without a fresh sign-in. (The proxies enforce the same rule for page
   * access; since Phase 16 Wave 2 the session.create.before hook also
   * refuses to mint a session for a non-ACTIVE user at sign-in time —
   * this check is the second layer for rows created before that hook.)
   */
  async function auth(): Promise<AdminSession | null> {
    const result = await betterAuth.api.getSession({
      headers: await headers(),
    })
    if (!result) return null
    const { user, session } = result
    const status = (user.status ?? "ACTIVE") as UserStatus
    if (status !== "ACTIVE") return null
    return {
      user: {
        id: user.id,
        name: user.name ?? null,
        email: user.email,
        image: user.image ?? null,
        platformRole: (user.platformRole ?? "PLATFORM_USER") as PlatformRole,
        status,
        adminRole: (user.adminRole ?? null) as AdminRole | null,
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
