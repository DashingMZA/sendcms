import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { readPlatformConfig } from "@sendcms/plans"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AiSettingsPanel } from "@/components/admin/ai-settings-panel"

export const metadata: Metadata = {
  title: "AI settings — SendCMS Admin",
  description: "Platform AI controls and the emergency switch.",
}

// AI settings (Phase 5). The emergency flag is read from the
// workspace-root config/config.json (the same source the entitlement
// resolver uses) and shown display-only — changing it needs a server
// restart, and it never disables form submission, the inbox, or any
// non-AI service.
export default async function AdminAiSettingsPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const { emergency } = readPlatformConfig()

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "ai")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("settingsTitle")}
        </h1>
        <p className="text-muted-foreground">{t("settingsDescription")}</p>
      </div>
      <AiSettingsPanel actorRole={actorRole} emergency={emergency} />
    </main>
  )
}
