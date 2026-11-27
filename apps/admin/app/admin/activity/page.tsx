import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { ActivityFeed } from "@/components/admin/activity-feed"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "activity")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Unified activity feed (Phase B, plan §3.1). Same shape as
// /admin/audit-logs: the server only authenticates and resolves the
// actor's role; the client component reads the feed through the api
// app. Reads need VIEW_AUDIT_LOGS. The feed is read-only — no
// mutations, so there is no single primary action and no PageHeader
// action slot (Wave 10 UX-110, same as the trials page).
export default async function AdminActivityPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "activity")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <ActivityFeed actorRole={actorRole} />
      </div>
    </div>
  )
}
