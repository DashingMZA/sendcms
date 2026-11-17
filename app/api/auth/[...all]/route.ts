import { betterAuth } from "@/lib/auth"
import { toNextJsHandler } from "better-auth/next-js"

/**
 * Better Auth handler — serves /api/auth/* (incl. /callback/google).
 * The Google redirect URI stays `<APP_URL>/api/auth/callback/google`,
 * same as before, so no Google Cloud Console change is needed.
 */
export const { GET, POST } = toNextJsHandler(betterAuth)
