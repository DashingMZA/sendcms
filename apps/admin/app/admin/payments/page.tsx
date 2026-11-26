import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { RiCloseLine, RiRefundLine, RiWalletLine } from "@remixicon/react"
import { StatCard } from "@sendcms/ui"
import { getPaymentStats, listPayments } from "@sendcms/billing"
import { PaymentsQuerySchema } from "@sendcms/billing/validators"
import { adminCan } from "@sendcms/permissions"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import {
  PaymentsTable,
  type PaymentTab,
} from "@/components/admin/payments-table"
import { formatAmountMinor } from "@/components/admin/plan-format"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "payments")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

const TABS: PaymentTab[] = ["all", "succeeded", "failed", "refunded"]

function parseTab(raw: string | string[] | undefined): PaymentTab {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value !== undefined && (TABS as string[]).includes(value)
    ? (value as PaymentTab)
    : "all"
}

// Admin payments list (Phase B, plan §3.5). The server fetches the
// 30-day stats and the active tab's list via the service layer and
// passes them down; the client table owns the tabs, search, provider
// filter, and pagination (URL-as-state). Refund is a per-row action
// behind MANAGE_BILLING + step-up — the services enforce it
// server-side regardless of what the UI shows.
//
// No PageHeader action slot: this page has no single primary action
// (refund lives on each row) — Wave 10 UX-110, do not invent one.
// The SidebarTrigger comes from PageHeader, as on every admin page.
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const raw = await searchParams
  const tab = parseTab(raw.tab)
  const parsed = PaymentsQuerySchema.safeParse({ ...raw, tab })
  const filters = parsed.success
    ? parsed.data
    : PaymentsQuerySchema.parse({ tab })

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")
  const canRefund = adminCan(actorRole, "MANAGE_BILLING")

  const [stats, initialData] = await Promise.all([
    getPaymentStats(session),
    listPayments(session, filters),
  ])

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "payments")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title={t("statPaid30d")}
            value={formatAmountMinor(
              locale,
              stats.paid30d.amountMinor,
              stats.paid30d.currency,
              t("amountUnknown")
            )}
            icon={RiWalletLine}
            variant="success"
            description={t("statPaid30dDescription", {
              count: stats.paid30d.count,
              unknown: stats.paid30d.unknownCount,
            })}
          />
          <StatCard
            title={t("statFailed30d")}
            value={formatAmountMinor(
              locale,
              stats.failed30d.amountMinor,
              stats.failed30d.currency,
              t("amountUnknown")
            )}
            icon={RiCloseLine}
            variant="destructive"
            description={t("statFailed30dDescription", {
              count: stats.failed30d.count,
              unknown: stats.failed30d.unknownCount,
            })}
          />
          <StatCard
            title={t("statRefunded30d")}
            value={formatAmountMinor(
              locale,
              stats.refunded30d.amountMinor,
              stats.refunded30d.currency,
              t("amountUnknown")
            )}
            icon={RiRefundLine}
            description={t("statRefunded30dDescription", {
              count: stats.refunded30d.count,
              unknown: stats.refunded30d.unknownCount,
            })}
          />
        </div>
        <PaymentsTable
          initialData={initialData}
          filters={filters}
          tab={tab}
          canRefund={canRefund}
        />
      </main>
    </div>
  )
}
