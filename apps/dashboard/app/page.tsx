import type { Metadata } from "next"
import Link from "next/link"
import { Button, Logo } from "@sendcms/ui"
import config from "@/config/config.json"
import { auth } from "@/lib/auth"
import { getRequestLocale, getTranslator } from "@/lib/i18n"

export const metadata: Metadata = {
  title: "SendCMS Dashboard",
  description:
    "Sign in to manage your SendCMS domains, forms, and submissions.",
}

// Root landing page: the dashboard app has no public homepage, so a
// direct visit lands here instead of a 404. Signed-out visitors get a
// sign-in button; signed-in users get a button to the overview.
export default async function HomePage() {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "landing")
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-svh flex-col items-center justify-center px-4 py-16 text-center"
    >
      <Logo brand={config.site} className="mb-6" />
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        {t("landingTitle")}
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {t("landingDescription")}
      </p>
      {session ? (
        <Button asChild>
          <Link href="/dashboard">{t("goToDashboard")}</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link href="/sign-in">{t("signIn")}</Link>
        </Button>
      )}
    </main>
  )
}
