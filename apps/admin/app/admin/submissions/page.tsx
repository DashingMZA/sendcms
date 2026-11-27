import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { PlatformSubmissions } from "@/components/admin/platform-submissions"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "submissions")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Abuse / spam queue (Phase 7). The server only authenticates and
// resolves the actor's role; the client component reads the queue
// through the api app. The list is metadata only and needs
// VIEW_CUSTOMER_DATA; the full submission needs
// VIEW_SENSITIVE_SUBMISSIONS; status changes need MANAGE_USERS.
export default async function AdminSubmissionsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "submissions")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <PlatformSubmissions actorRole={actorRole} />
      </div>
    </div>
  )
}
