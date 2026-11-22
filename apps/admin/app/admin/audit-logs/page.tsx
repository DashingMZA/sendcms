import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AuditLogsOverview } from "@/components/admin/audit-logs-overview"

export const metadata: Metadata = {
  title: "Audit logs — SendCMS Admin",
  description: "Every admin action, newest first. The log is append-only.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "audit-logs")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <AuditLogsOverview actorRole={actorRole} />
    </main>
  )
}
