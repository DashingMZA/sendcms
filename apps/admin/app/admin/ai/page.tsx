import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { AiOverview } from "@/components/admin/ai-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "ai")
  return {
    title: `${t("overviewTitle")} — SendCMS Admin`,
    description: t("overviewDescription"),
  }
}

// AI overview (Phase 5). The server only authenticates and resolves
// the actor's role; the client component reads the usage summary and
// provider health through the api app (the platform-key flag comes
// from the api app's env, so a server-side read here would be wrong).
export default async function AdminAiPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader
        title={t("overviewTitle")}
        description={t("overviewDescription")}
      />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <AiOverview actorRole={actorRole} />
      </div>
    </div>
  )
}
