import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AiOverview } from "@/components/admin/ai-overview"

export const metadata: Metadata = {
  title: "AI — SendCMS Admin",
  description: "Manage AI providers, BYOK, and platform AI controls.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "ai")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("overviewTitle")}
        </h1>
        <p className="text-muted-foreground">{t("overviewDescription")}</p>
      </div>
      <AiOverview actorRole={actorRole} />
    </main>
  )
}
