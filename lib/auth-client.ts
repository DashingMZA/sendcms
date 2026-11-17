import { createAuthClient } from "better-auth/react"

/**
 * Browser-side Better Auth client. Same-origin `/api/auth` — no baseURL
 * needed. Server code must use `@/lib/auth` (`auth()` / `betterAuth`)
 * instead of this.
 */
export const authClient = createAuthClient()

export const { signIn, signOut, useSession } = authClient
