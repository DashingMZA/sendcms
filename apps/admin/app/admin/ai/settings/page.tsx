import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { readPlatformConfig } from "@sendcms/plans"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { AiSettingsPanel } from "@/components/admin/ai-settings-panel"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "ai")
  return {
    title: `${t("settingsTitle")} — SendCMS Admin`,
    description: t("settingsDescription"),
  }
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

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader
        title={t("settingsTitle")}
        description={t("settingsDescription")}
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <AiSettingsPanel actorRole={actorRole} emergency={emergency} />
      </main>
    </div>
  )
}
