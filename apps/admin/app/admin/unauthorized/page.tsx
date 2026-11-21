import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@sendcms/ui"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { dashboardSignInURL } from "@/lib/callback-url"

export const metadata: Metadata = {
  title: "Not authorized — SendCMS Admin",
  description: "Your account does not have access to the Admin Control Plane.",
}

// Shown to a signed-in user whose account has no admin capability
// (the proxy redirects here instead of the dashboard, so the denial is
// explicit). The proxy allows this page through without the capability
// — it is the denial page itself.
export default async function UnauthorizedPage() {
  const locale = await getRequestLocale()
  const tErrors = await getTranslator(locale, "errors")
  const tAuth = await getTranslator(locale, "auth")
  return (
    <main
      id="main-content"
      className="flex flex-col items-center justify-center px-4 py-16 text-center"
    >
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        {tErrors("forbidden")}
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {tErrors("unauthorized")}
      </p>
      <Button asChild>
        <Link href={dashboardSignInURL()}>{tAuth("signIn")}</Link>
      </Button>
    </main>
  )
}
