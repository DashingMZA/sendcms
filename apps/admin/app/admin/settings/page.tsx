import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { SystemOverview } from "@/components/admin/system-overview"

export const metadata: Metadata = {
  title: "Settings — SendCMS Admin",
  description: "Platform settings and configuration.",
}

// Platform settings (Phase 7 — replaces the Phase 2 planned empty
// state). The server only authenticates; the client component reads
// the system summary through the api app. Reads need
// VIEW_ADMIN_DASHBOARD.
export default async function AdminSettingsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "settings")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <SystemOverview />
    </main>
  )
}
