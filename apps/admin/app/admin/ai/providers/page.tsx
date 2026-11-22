import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AiProviders } from "@/components/admin/ai-providers"

export const metadata: Metadata = {
  title: "AI providers — SendCMS Admin",
  description: "Enable or disable AI providers for the platform key.",
}

// AI providers (Phase 5). The server only authenticates and resolves
// the actor's role; the client component reads and edits the provider
// config through the api app.
export default async function AdminAiProvidersPage() {
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
          {t("providersTitle")}
        </h1>
        <p className="text-muted-foreground">{t("providersDescription")}</p>
      </div>
      <AiProviders actorRole={actorRole} />
    </main>
  )
}
