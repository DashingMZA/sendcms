import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"
import { auth } from "@/lib/auth"
import { getRequestLocale, getTranslator } from "@/lib/i18n"

export const metadata: Metadata = {
  title: "Page not found — SendCMS Dashboard",
  description: "The page you're looking for doesn't exist or was moved.",
  // Error page — never indexed (Phase 16, PRF-034).
  robots: { index: false, follow: false },
}

// Dashboard 404: back to the overview, or to sign-in. The visible
// copy goes through t() like the admin 404 (I18N-009); only the
// metadata title/description above stay English (I18N-204).
export default async function NotFound() {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const tErrors = await getTranslator(locale, "errors")
  const tNav = await getTranslator(locale, "navigation")
  const tAuth = await getTranslator(locale, "auth")
  return (
    <NotFoundPage
      title={tErrors("notFoundTitle")}
      message={tErrors("notFoundDescription")}
      links={[
        { href: "/dashboard", label: tNav("backToDashboard"), primary: true },
        { href: "/sign-in", label: tAuth("signIn") },
      ]}
    />
  )
}
