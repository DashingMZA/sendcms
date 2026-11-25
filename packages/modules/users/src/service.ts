import { db } from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

import { SetLocaleSchema } from "./validators"

export async function lookupUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase()
  const user = await db.user.findUnique({ where: { email: normalized } })
  // Generic not-found: the message must not confirm or deny whether
  // an account exists for the probed address (SRC-228). No route
  // exposes this lookup today — it is an admin-service helper — so
  // the generic message costs no admin UX.
  if (!user) throw new ApiError("User not found", 404)
  return { id: user.id, name: user.name, email: user.email }
}

/**
 * How the admin user signs in: which OAuth providers are linked and
 * whether they have an email/password credential ("credential" account).
 * Used by the dashboard account page to decide which settings to show.
 */
export async function getUserAuthMethods(userId: string): Promise<{
  hasPassword: boolean
  providers: string[]
}> {
  const accounts = await db.account.findMany({
    where: { userId },
    select: { providerId: true },
  })
  const providers = accounts.map((a) => a.providerId)
  return { hasPassword: providers.includes("credential"), providers }
}

/**
 * Preferred UI locale for a user (BCP 47 code, e.g. "en", "ur").
 * Null means no preference is stored — the app falls back to English
 * (and offers the language prompt on first visit). The caller validates
 * the code against SetLocaleSchema before calling this.
 */
export async function getUserLocale(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  })
  if (!user) throw new ApiError("No user found", 404)
  return user.locale
}

/**
 * Store a user's preferred UI locale (SRC-227). Validates the code
 * inside the service as defense-in-depth — the route validates too,
 * but any direct caller (server component, MCP tool) used to be able
 * to store an arbitrary string — and returns 404 for an unknown user
 * instead of letting Prisma's P2025 surface as a generic 500.
 * Only locales with complete translation files are storable
 * (I18N-307: coming-soon codes are rejected, not stored).
 */
export async function setUserLocale(userId: string, locale: string) {
  const parsed = SetLocaleSchema.safeParse({ locale })
  if (!parsed.success) {
    throw new ApiError("Invalid locale", 422)
  }
  const existing = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!existing) throw new ApiError("No user found", 404)
  const user = await db.user.update({
    where: { id: userId },
    data: { locale: parsed.data.locale },
    select: { id: true, locale: true },
  })
  return user
}
