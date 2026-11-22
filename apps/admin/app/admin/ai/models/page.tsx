import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AiModels } from "@/components/admin/ai-models"

export const metadata: Metadata = {
  title: "AI models — SendCMS Admin",
  description: "Configured models per provider, and models actually in use.",
}

// AI models (Phase 5). The server only authenticates and resolves
// the actor's role; the client component reads the provider config
// and the usage list through the api app.
export default async function AdminAiModelsPage() {
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
          {t("modelsTitle")}
        </h1>
        <p className="text-muted-foreground">{t("modelsDescription")}</p>
      </div>
      <AiModels actorRole={actorRole} />
    </main>
  )
}
