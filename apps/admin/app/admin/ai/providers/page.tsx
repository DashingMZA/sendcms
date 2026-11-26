import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { AiProviders } from "@/components/admin/ai-providers"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "ai")
  return {
    title: `${t("providersTitle")} — SendCMS Admin`,
    description: t("providersDescription"),
  }
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

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader
        title={t("providersTitle")}
        description={t("providersDescription")}
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <AiProviders actorRole={actorRole} />
      </main>
    </div>
  )
}
