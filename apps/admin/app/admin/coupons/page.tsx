import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { RiCouponLine, RiPercentLine, RiPriceTag3Line } from "@remixicon/react"
import { StatCard } from "@sendcms/ui"
import { formatCurrency, formatNumber } from "@sendcms/i18n"
import {
  listCouponRedemptions,
  listCoupons,
  type CouponSummary,
} from "@sendcms/coupons"
import {
  CouponsQuerySchema,
  type CouponsQuery,
} from "@sendcms/coupons/validators"
import type { AdminSession } from "@sendcms/auth"
import { adminCan } from "@sendcms/permissions"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import {
  CouponsTable,
  type CouponRow,
  type CouponTab,
  type CouponsPage,
} from "@/components/admin/coupons-table"
import { CouponsCreateDialog } from "@/components/admin/coupons-create-dialog"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "coupons")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

const TABS: CouponTab[] = ["active", "disabled", "expired"]

// URL tabs stay lowercase (jobs-page pattern); the service filter
// uses the uppercase CouponStatus values.
const TAB_TO_STATUS: Record<CouponTab, CouponsQuery["status"]> = {
  active: "ACTIVE",
  disabled: "DISABLED",
  expired: "EXPIRED",
}

function parseTab(raw: string | string[] | undefined): CouponTab {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value !== undefined && (TABS as string[]).includes(value)
    ? (value as CouponTab)
    : "active"
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return toIso(value)
}

/** Serialise a service coupon row for the client table (dates → ISO
    strings). No nested objects: the row is flat, like the payments
    row the table is modelled on. */
function toClientCoupon(row: CouponSummary): CouponRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    discountType: row.discountType,
    discountValue: row.discountValue,
    currency: row.currency,
    maxRedemptions: row.maxRedemptions,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    redemptionCount: row.redemptionCount,
    validFrom: toIsoOrNull(row.validFrom),
    validUntil: toIsoOrNull(row.validUntil),
    appliesToPlanIds: row.appliesToPlanIds,
    appliesToBillingInterval: row.appliesToBillingInterval,
    firstPurchaseOnly: row.firstPurchaseOnly,
    status: row.status,
    createdById: row.createdById,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

type CouponStats30d = {
  activeCodes: number
  redemptions30d: number
  /** Minor-units total per currency, e.g. { USD: 12500 }. */
  discountedByCurrency: Map<string, number>
}

/**
 * 30-day stats from the contract functions only (listCoupons +
 * listCouponRedemptions) — the coupons service has no stats helper
 * yet. Active codes come from the list total; redemptions and the
 * discounted total are aggregated per coupon (newest redemption
 * pages first, 30-day window applied in-page). A future
 * getCouponStats service helper can replace this whole function;
 * the StatCards below must not change shape when it does.
 */
async function getCouponStats30d(
  session: AdminSession
): Promise<CouponStats30d> {
  const since = new Date(Date.now() - THIRTY_DAYS_MS)
  const active = await listCoupons(session, {
    status: "ACTIVE",
    page: 1,
    perPage: 1,
  })
  let redemptions30d = 0
  const discountedByCurrency = new Map<string, number>()
  let page = 1
  for (;;) {
    const list = await listCoupons(session, {
      status: "all",
      page,
      perPage: 100,
    })
    for (const coupon of list.coupons) {
      let redemptionPage = 1
      for (;;) {
        const redemptions = await listCouponRedemptions(session, coupon.id, {
          page: redemptionPage,
          perPage: 100,
        })
        for (const row of redemptions.redemptions) {
          if (new Date(row.createdAt) >= since) {
            redemptions30d += 1
            discountedByCurrency.set(
              row.currency,
              (discountedByCurrency.get(row.currency) ?? 0) + row.discountAmount
            )
          }
        }
        if (redemptionPage >= redemptions.totalPages) break
        redemptionPage += 1
      }
    }
    if (page >= list.totalPages) break
    page += 1
  }
  return { activeCodes: active.total, redemptions30d, discountedByCurrency }
}

// Admin coupons page (Phase D, plan §3.7). StatCard row (active
// codes / redemptions 30d / total discounted 30d) + coupons table
// (Tabs: Active / Disabled / Expired) + create dialog in the
// PageHeader action slot (UX-110: the create action lives in the
// slot only, no in-content duplicate) + coupon detail (redemptions
// table inside the table component's detail dialog).
//
// View: VIEW_BILLING (SUPER_ADMIN + MANAGER + owner; SUPPORT cannot
// see coupons — the proxy enforces it via the /admin/coupons
// route-capability entry). Manage (create / disable / delete):
// MANAGE_BILLING (SUPER_ADMIN + owner only — Q10, MANAGER may NOT
// create). No step-up for create/disable (reversible); delete is a
// soft-disable, also no step-up.
export default async function AdminCouponsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const raw = await searchParams
  const tab = parseTab(raw.tab)
  const parsed = CouponsQuerySchema.safeParse({
    status: TAB_TO_STATUS[tab],
    search: raw.search,
    page: raw.page,
  })
  const filters = parsed.success
    ? parsed.data
    : CouponsQuerySchema.parse({ status: TAB_TO_STATUS[tab] })

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")
  const canManage = adminCan(actorRole, "MANAGE_BILLING")

  const [stats, list] = await Promise.all([
    getCouponStats30d(session),
    listCoupons(session, filters),
  ])

  const initialData: CouponsPage = {
    coupons: list.coupons.map(toClientCoupon),
    total: list.total,
    page: list.page,
    perPage: list.perPage,
    totalPages: list.totalPages,
  }

  // The discounted total renders in the currency with the most
  // discounted minor units (the platform default is USD; FIXED
  // coupons in another currency are the only multi-currency case).
  // Zero redemptions renders as a zero amount in USD, never unknown.
  let discountedCurrency = "USD"
  let discountedAmount = 0
  for (const [currency, amount] of stats.discountedByCurrency) {
    if (amount > discountedAmount) {
      discountedCurrency = currency
      discountedAmount = amount
    }
  }

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "coupons")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          canManage ? <CouponsCreateDialog canManage={canManage} /> : undefined
        }
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            title={t("statActive")}
            value={formatNumber(locale, stats.activeCodes)}
            icon={RiPriceTag3Line}
            description={t("statActiveDescription")}
          />
          <StatCard
            title={t("statRedemptions30d")}
            value={formatNumber(locale, stats.redemptions30d)}
            icon={RiCouponLine}
            description={t("statRedemptions30dDescription")}
          />
          <StatCard
            title={t("statDiscounted30d")}
            value={formatCurrency(
              locale,
              discountedAmount / 100,
              discountedCurrency
            )}
            icon={RiPercentLine}
            variant={discountedAmount > 0 ? "success" : "default"}
            description={t("statDiscounted30dDescription", {
              count: stats.redemptions30d,
            })}
          />
        </div>

        <CouponsTable
          initialData={initialData}
          filters={filters}
          tab={tab}
          canManage={canManage}
        />
      </main>
    </div>
  )
}
