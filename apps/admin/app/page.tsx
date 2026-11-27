import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import { Button, Logo, Skeleton } from "@sendcms/ui"
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

// The session-dependent call to action, behind a Suspense boundary
// (PRF-006): the shell below renders without waiting for the session
// lookup, so the logo/title/description stream immediately and only
// the button waits for the session.
async function LandingActions() {
  // I18N-203: auth first so the stored preference can resolve below.
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const tLanding = await getTranslator(locale, "landing")
  const tAuth = await getTranslator(locale, "auth")
  const isAdmin =
    session?.user.platformRole === "PLATFORM_OWNER" ||
    session?.user.adminRole !== null
  if (!session) {
    return (
      <Button asChild>
        <Link href={dashboardSignInURL()}>{tAuth("signIn")}</Link>
      </Button>
    )
  }
  if (isAdmin) {
    return (
      <Button asChild>
        <Link href={adminCallbackURL()}>{tLanding("goToAdmin")}</Link>
      </Button>
    )
  }
  return (
    <Button asChild>
      <Link href={dashboardURL()}>{tLanding("goToDashboard")}</Link>
    </Button>
  )
}

// Root landing page: the admin app has no public homepage, so a direct
// visit lands here instead of a 404. Signed-out visitors get a sign-in
// button (sign-in lives on the dashboard app). Signed-in admins get a
// button to the admin overview; other signed-in users get a button to
// their dashboard.
export default async function HomePage() {
  // The shell needs no session: the locale comes from the cookie only
  // (signed-out visitors have no stored preference to resolve).
  const locale = await getRequestLocale()
  const tLanding = await getTranslator(locale, "landing")
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-svh flex-col items-center justify-center px-4 py-16 text-center"
    >
      <Logo brand={config.site} className="mb-6" />
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        {tLanding("title")}
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {tLanding("description")}
      </p>
      <Suspense fallback={<Skeleton className="h-10 w-40" />}>
        <LandingActions />
      </Suspense>
    </main>
  )
}
