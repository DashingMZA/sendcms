import type { Metadata } from "next"
import Link from "next/link"
import { Button, Logo } from "@sendcms/ui"
import config from "@/config/config.json"
import { auth } from "@/lib/auth"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import {
  adminCallbackURL,
  dashboardSignInURL,
  dashboardURL,
} from "@/lib/callback-url"

export const metadata: Metadata = {
  title: "SendCMS Admin",
  description:
    "SendCMS Admin Control Plane — manage users, plans, subscriptions, AI and MCP access, and platform operations.",
}

// Root landing page: the admin app has no public homepage, so a direct
// visit lands here instead of a 404. Signed-out visitors get a sign-in
// button (sign-in lives on the dashboard app). Signed-in admins get a
// button to the admin overview; other signed-in users get a button to
// their dashboard.
export default async function HomePage() {
  const locale = await getRequestLocale()
  const tLanding = await getTranslator(locale, "landing")
  const tAuth = await getTranslator(locale, "auth")
  const session = await auth()
  const isAdmin =
    session?.user.platformRole === "PLATFORM_OWNER" ||
    session?.user.adminRole !== null
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center px-4 py-16 text-center"
    >
      <Logo brand={config.site} className="mb-6" />
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        {tLanding("title")}
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {tLanding("description")}
      </p>
      {!session ? (
        <Button asChild>
          <Link href={dashboardSignInURL()}>{tAuth("signIn")}</Link>
        </Button>
      ) : isAdmin ? (
        <Button asChild>
          <Link href={adminCallbackURL()}>{tLanding("goToAdmin")}</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link href={dashboardURL()}>{tLanding("goToDashboard")}</Link>
        </Button>
      )}
    </main>
  )
}
