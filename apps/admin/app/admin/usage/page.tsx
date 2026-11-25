import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { UsageOverview } from "@/components/admin/usage-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "usage")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Usage overview (Phase 4). Client-owned: pick a user, then the
// per-meter table reads the usage endpoint for that user and the
// effective entitlements for their limits.
export default async function AdminUsagePage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "usage")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <UsageOverview />
    </main>
  )
}
