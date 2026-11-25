import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getAdminOverview } from "@sendcms/platform-ops"
import { OverviewQuerySchema } from "@sendcms/platform-ops/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { OverviewDashboard } from "@/components/admin/overview-dashboard"

export const metadata: Metadata = {
  title: "Overview — SendCMS Admin",
  description: "Platform administration overview.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "overview")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <OverviewDashboard initialData={overview} query={query} />
    </main>
  )
}
