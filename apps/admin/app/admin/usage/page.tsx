import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
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
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <UsageOverview />
      </div>
    </div>
  )
}
