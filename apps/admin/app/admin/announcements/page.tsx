import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AnnouncementsOverview } from "@/components/admin/announcements-overview"

export const metadata: Metadata = {
  title: "Announcements — SendCMS Admin",
  description:
    "Platform announcements for the customer dashboard and the admin app.",
}

// Announcements (Phase 7). The server only authenticates and resolves
// the actor's role; the client component reads the announcements
// through the api app. The announcements page is a management page —
// only owner + SUPER_ADMIN hold MANAGE_ANNOUNCEMENTS.
export default async function AdminAnnouncementsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "announcements")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <AnnouncementsOverview actorRole={actorRole} />
    </main>
  )
}
