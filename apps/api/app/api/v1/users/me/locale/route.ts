import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { setUserLocale } from "@sendcms/users"
import { SetLocaleSchema } from "@sendcms/users/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Stores the signed-in user's preferred UI locale in the database, so a
// language switch (e.g. en -> ur) survives across browsers and sessions.
// The browser cookie (sendcms-locale) is the fast path; this is the
// durable one. Validated against the locale registry in @sendcms/i18n.
export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const body = await req.json().catch(() => ({}))
    const parsed = SetLocaleSchema.safeParse(body)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const user = await setUserLocale(session.user.id, parsed.data.locale)
    return ok({ locale: user.locale })
  } catch (err) {
    return handleApiError(err)
  }
}
