import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { HealthOverview } from "@/components/admin/health-overview"

export const metadata: Metadata = {
  title: "Platform health — SendCMS Admin",
  description: "Live platform state. Every number is a real query.",
}

// Platform health (Phase 7). The server only authenticates; the
// client component reads the health through the api app. Reads need
// VIEW_ADMIN_DASHBOARD.
export default async function AdminHealthPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "health")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <HealthOverview />
    </main>
  )
}
