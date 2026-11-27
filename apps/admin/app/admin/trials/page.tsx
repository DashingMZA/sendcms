import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import {
  RiCheckLine,
  RiCloseLine,
  RiRepeatLine,
  RiTimeLine,
} from "@remixicon/react"
import { StatCard } from "@sendcms/ui"
import {
  getTrialStats,
  listEndedTrials,
  listPlans,
  listSubscriptions,
} from "@sendcms/plans"
import { SubscriptionListQuerySchema } from "@sendcms/plans/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { TrialsTable, type TrialTab } from "@/components/admin/trials-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "trials")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

const TABS: TrialTab[] = ["active", "expiring", "ended"]

function parseTab(raw: string | string[] | undefined): TrialTab {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value !== undefined && (TABS as string[]).includes(value)
    ? (value as TrialTab)
    : "active"
}

// Admin trials list (Phase A, plan §3.4). Trial state is derived
// (TRIALING + currentPeriodEnd — see getTrialStats): the server
// fetches the stats and the active tab's list via the service layer
// and passes them down; the client table owns the tabs, search, plan
// filter, and pagination (URL-as-state). No PageHeader action slot:
// this page has no single primary action — trial cancel / extend /
// convert live on the existing subscription detail (the subscriber's
// user Package tab), linked from each row (Wave 10 UX-110, do not
// invent an action).
export default async function AdminTrialsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const raw = await searchParams
  const tab = parseTab(raw.tab)
  const filters = SubscriptionListQuerySchema.parse(raw)

  // One clock for the stats and the expiring tab's bound, so the
  // "expiring soon" stat and the "Expiring soon" tab can never
  // disagree about what "within 7 days" means.
  const now = new Date()
  const endsBefore = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [stats, initialData, plansData] = await Promise.all([
    getTrialStats(session, now),
    tab === "ended"
      ? listEndedTrials(session, filters)
      : listSubscriptions(session, {
          ...filters,
          status: "TRIALING",
          ...(tab === "expiring"
            ? { endsBefore: endsBefore.toISOString() }
            : { endsBefore: undefined }),
        }),
    listPlans(session, { page: 1, perPage: 100, sort: "createdAt:desc" }),
  ])

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "trials")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t("statActiveTrials")}
            value={stats.activeTrials}
            icon={RiRepeatLine}
            description={t("statActiveTrialsDescription")}
          />
          <StatCard
            title={t("statExpiringSoon")}
            value={stats.expiringSoon}
            icon={RiTimeLine}
            variant="warning"
            description={t("statExpiringSoonDescription")}
          />
          <StatCard
            title={t("statConverted")}
            value={stats.convertedLast30Days}
            icon={RiCheckLine}
            variant="success"
            description={t("statConvertedDescription")}
          />
          <StatCard
            title={t("statExpired")}
            value={stats.expiredLast30Days}
            icon={RiCloseLine}
            description={t("statExpiredDescription")}
          />
        </div>
        <TrialsTable
          initialData={initialData}
          filters={filters}
          tab={tab}
          plans={plansData.plans}
        />
      </div>
    </div>
  )
}
