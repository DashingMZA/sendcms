import { db } from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

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

export async function setUserLocale(userId: string, locale: string) {
  const user = await db.user.update({
    where: { id: userId },
    data: { locale },
    select: { id: true, locale: true },
  })
  return user
}
