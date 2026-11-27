import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { AuditLogsOverview } from "@/components/admin/audit-logs-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "audit-logs")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Audit log explorer (Phase 7). The server only authenticates and
// resolves the actor's role; the client component reads the logs
// through the api app. Reads need VIEW_AUDIT_LOGS; the export needs
// EXPORT_AUDIT_LOGS. The log is append-only — no edit or delete.
export default async function AdminAuditLogsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "audit-logs")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <AuditLogsOverview actorRole={actorRole} />
      </div>
    </div>
  )
}
