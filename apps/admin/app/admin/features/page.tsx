import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { FeaturesOverview } from "@/components/admin/features-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "features")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Feature flags (Phase 7). The server only authenticates and resolves
// the actor's role; the client component reads the flags through the
// api app. The flags page is a management page — only owner +
// SUPER_ADMIN hold MANAGE_FEATURE_FLAGS.
export default async function AdminFeaturesPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "features")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <FeaturesOverview actorRole={actorRole} />
      </main>
    </div>
  )
}
