import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"
import { auth } from "@/lib/auth"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { dashboardSignInURL } from "@/lib/callback-url"

export const metadata: Metadata = {
  title: "Page not found — SendCMS Admin",
  description: "The page you're looking for doesn't exist or was moved.",
  // Error page — never indexed (Phase 16, PRF-034).
  robots: { index: false, follow: false },
}

// Admin 404: back to the admin overview, or to sign-in (the admin app
// has no sign-in page of its own — sign-in lives on the dashboard app).
export default async function NotFound() {
  // I18N-203: pass the signed-in user's id when there is one, so a
  // stored `ur` preference renders the 404 in Urdu; signed-out
  // visitors resolve cookie-only as before.
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const tErrors = await getTranslator(locale, "errors")
  const tNav = await getTranslator(locale, "navigation")
  const tAuth = await getTranslator(locale, "auth")
  return (
    <NotFoundPage
      message={tErrors("notFound")}
      links={[
        { href: "/admin", label: tNav("overview"), primary: true },
        { href: dashboardSignInURL(), label: tAuth("signIn") },
      ]}
    />
  )
}
