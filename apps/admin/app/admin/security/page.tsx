import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { SecurityOverview } from "@/components/admin/security-overview"

export const metadata: Metadata = {
  title: "Security — SendCMS Admin",
  description: "Deletion requests and the account erasure workflow.",
}

// Deletion requests (Phase 7). The server only authenticates and
// resolves the actor's role; the client component reads the requests
// through the api app. Review and erasure need MANAGE_USERS.
export default async function AdminSecurityPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "security")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <SecurityOverview actorRole={actorRole} />
    </main>
  )
}
