# Auth System

Two separate auth systems. Never conflate them.

## Admin Auth

| Aspect         | Detail                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism      | Better Auth 1.7.x — Google/GitHub/Facebook OAuth + email/password (verification required)                                                                                                       |
| Storage        | Server session cookie (database session)                                                                                                                                                        |
| Routes         | `/dashboard`, `/api/v1/*`                                                                                                                                                                       |
| Gate           | `proxy.ts` (root, not `middleware.ts`)                                                                                                                                                          |
| Matcher        | `/dashboard/:path*`                                                                                                                                                                             |
| Config         | `packages/auth/src/auth.ts` (`createSendcmsAuth`, with Prisma) — wired by the thin `lib/auth.ts` wrapper, which injects the app's mailer                                                        |
| Providers      | `packages/auth/src/providers.ts` — `getConfiguredOAuthProviders()` (Google always; GitHub/Facebook only when their env creds are set)                                                           |
| Client         | `@sendcms/auth/client` (`authClient.signIn` / `signUp` / `signOut` / `verifyEmail` / `requestPasswordReset` / `resetPassword` / `changePassword` / `changeEmail` / `updateUser` / `linkSocial`) |
| Session helper | `auth()` from `@sendcms/auth` (re-exported by `lib/auth.ts`) — same `await auth()` pattern; `AdminSession.user.emailVerified`                                                                   |
| Auth mail      | `lib/email/auth-mailer.ts` — verification + reset via platform SMTP (`SMTP_*`); no SMTP → dev logs the link to the server console, production throws                                            |

## Email / Password Flows

- **Sign-up** (`/sign-up`): `signUp.email` creates the account WITHOUT a session and sends the verification email. The user signs in only after verifying. Duplicate emails get the same generic success (no enumeration).
- **Sign-in** (`/sign-in`): `signIn.email` is refused while the email is unverified (`EMAIL_NOT_VERIFIED`) — the UI offers a resend. Verified users sign in normally.
- **Verification**: the email link is `/api/auth/verify-email?token=…&callbackURL=…` (Better Auth's own endpoint — it verifies, signs the user in when `autoSignInAfterVerification`, and redirects to the callback URL). The app's `/verify-email` page is a manual fallback that calls the same endpoint via `verifyEmail`. Tokens expire after 24h (`emailVerification.expiresIn`).
- **Reset**: `/forgot-password` calls `requestPasswordReset` with `redirectTo: "/reset-password"` (required — without it the email link has an empty callback URL and lands on an error). The email link is `/api/auth/reset-password/:token?callbackURL=/reset-password`; the API validates the token and redirects to `/reset-password?token=…`, where the form calls `resetPassword`. Reset links expire after 1h. A successful reset writes an `AuditLog` row (`UPDATE` / `USER` / `password-reset`).
- **Account** (`/dashboard/account`): verification status + resend, name change (`updateUser`), email change (`changeEmail` — the verification email goes to the NEW address, change applies only after it is verified), password change (`changePassword`, revokes other sessions), link additional OAuth providers (`linkSocial`).
- **Verification trust by provider** (verified in better-auth 1.7.25 source): Google trusts its profile `email_verified`; GitHub checks the `verified` flag of the matching address in `/user/emails`; Facebook reports none, so Facebook users land with `emailVerified: false` and get a verification email on sign-up (`sendOnSignUp`). Verification gates domain registration / submissions, not dashboard access.
- **First user**: becomes `PLATFORM_OWNER` via a single-statement conditional `UPDATE … WHERE NOT EXISTS` in the user-create hook, backed by the partial unique index `User_single_platform_owner_idx`. Promotion is best-effort — it never fails registration.

**Route pattern:**

```ts
import { auth } from "@/lib/auth"
const session = await auth()
if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
```

## Visitor Auth

There is none. The comment system's visitor auth (Google OAuth PKCE →
with it on 2026-11-18. Visitors never sign in; the public submission API
takes no credentials — the `Origin` allowlist is its authorization.

## Permission Guards

| Guard                           | Location                      | Used By                                                                             |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `platformCan(role, capability)` | `lib/permissions/platform.ts` | Dashboard nav visibility                                                            |
| `getEffectiveOrigin(req)`       | `lib/cors.ts`                 | Resolves origin from `origin` header, falls back to `referer` (public submit route) |

## Critical Rules

- Admin routes gated by `proxy.ts`, not inline checks
- Public submit route: no cookies, no session — Origin allowlist only;
  it exports `OPTIONS` for CORS preflight and echoes `corsHeaders(origin)`
  on all responses for allowed origins
