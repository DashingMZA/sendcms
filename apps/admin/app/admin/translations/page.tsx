import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { TranslationsOverview } from "@/components/admin/translations-overview"

export const metadata: Metadata = {
  title: "Translations — SendCMS Admin",
  description:
    "Translation completion for every locale, compared against English.",
}

// Translation management (Phase 7). The server only authenticates
// and resolves the actor's role; the client component reads the
// completion report through the api app. Reads need
// MANAGE_TRANSLATIONS. Read-only by design — no ordinary admin may
// overwrite translation files from the browser.
export default async function AdminTranslationsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "translations")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <TranslationsOverview actorRole={actorRole} />
    </main>
  )
}
