import { db } from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

export async function lookupUserByEmail(email: string) {
  const normalized = email.toLowerCase()
  const user = await db.user.findUnique({ where: { email: normalized } })
  if (!user) throw new ApiError("No user found with that email", 404)
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
