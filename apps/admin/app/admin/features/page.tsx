import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { FeaturesOverview } from "@/components/admin/features-overview"

export const metadata: Metadata = {
  title: "Feature flags — SendCMS Admin",
  description: "Turn platform features on and off, globally or for one user.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "features")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <FeaturesOverview actorRole={actorRole} />
    </main>
  )
}
