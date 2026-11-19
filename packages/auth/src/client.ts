import { createAuthClient } from "better-auth/react"

/**
 * Browser-side Better Auth client. Same-origin `/api/auth` when
 * NEXT_PUBLIC_AUTH_URL is unset (the single-app case). In the split
 * monorepo (Phase 7) the auth handler lives in the api app, so the
 * dashboard app sets NEXT_PUBLIC_AUTH_URL to the api app's URL (dev:
 * http://localhost:3001) and the client posts cross-origin there.
 * Server code must use `@/lib/auth` (`auth()` / `betterAuth`) instead
 * of this.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_URL,
})

export const { signIn, signOut, useSession } = authClient
