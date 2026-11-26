import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { HealthOverview } from "@/components/admin/health-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "health")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Platform health (Phase 7). The server only authenticates; the
// client component reads the health through the api app. Reads need
// VIEW_ADMIN_DASHBOARD.
export default async function AdminHealthPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "health")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <HealthOverview />
      </main>
    </div>
  )
}
