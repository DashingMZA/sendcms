import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getAdminOverview } from "@sendcms/platform-ops"
import { OverviewQuerySchema } from "@sendcms/platform-ops/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { OverviewDashboard } from "@/components/admin/overview-dashboard"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "overview")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Admin overview (Phase 9, spec §3). Real DB-backed stats for a date
// range — no hardcoded numbers, no fake charts. The server fetches the
// overview and passes it as initialData; the client component owns the
// range filter through the URL. An invalid range in the URL falls back
// to the 7d default instead of erroring the page.
export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const parsed = OverviewQuerySchema.safeParse(await searchParams)
  // ADM-008: an invalid range in the URL used to render 7d data while
  // the URL still said `range=bogus` (or `custom`) — the highlighted
  // button and the URL disagreed. Redirect to the defaulted URL so
  // the URL always describes the rendered range.
  if (!parsed.success) redirect("/admin")
  const query = parsed.data
  const overview = await getAdminOverview(session, query)

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "overview")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <OverviewDashboard initialData={overview} query={query} />
      </main>
    </div>
  )
}
