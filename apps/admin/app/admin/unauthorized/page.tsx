import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@sendcms/ui"
import { auth } from "@/lib/auth"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const tErrors = await getTranslator(locale, "errors")
  return {
    title: `${tErrors("forbiddenTitle")} — SendCMS Admin`,
    description: tErrors("unauthorized"),
  }
}

// Shown to a signed-in user whose account has no admin capability
// (the proxy redirects here instead of the dashboard, so the denial is
// explicit). The proxy allows this page through without the capability
// — it is the denial page itself.
export default async function UnauthorizedPage() {
  // I18N-203: the denied user is signed in — pass their id so a
  // stored `ur` preference renders this page in Urdu, not English.
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const tErrors = await getTranslator(locale, "errors")
  const tAuth = await getTranslator(locale, "auth")
  return (
    <div>
      <PageHeader
        title={tErrors("forbidden")}
        description={tErrors("unauthorized")}
      />
      <main
        id="main-content"
        className="flex flex-col items-center justify-center px-4 py-16 text-center"
      >
        <Button asChild>
          <Link href={dashboardSignInURL()}>{tAuth("signIn")}</Link>
        </Button>
      </main>
    </div>
  )
}
