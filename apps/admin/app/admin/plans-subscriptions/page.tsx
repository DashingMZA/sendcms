import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listPlans, listSubscriptions } from "@sendcms/plans"
import {
  PlanListQuerySchema,
  SubscriptionListQuerySchema,
} from "@sendcms/plans/validators"
import { adminCan } from "@sendcms/permissions"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { PlansTable } from "@/components/admin/plans-table"
import { SubscriptionsTable } from "@/components/admin/subscriptions-table"
import { PlansSubscriptionsTabs } from "@/components/admin/plans-subscriptions-tabs"
import { getPlansSubscriptionsStats } from "@/lib/plans-subscriptions-stats"
import { StatCard } from "@sendcms/ui"
import {
  RiAlertLine,
  RiPriceTag3Line,
  RiRepeatLine,
  RiTimeLine,
} from "@remixicon/react"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "plans-subscriptions")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Admin plans + subscriptions combined view (Phase A, plan §3.3).
// This page COMPOSES the two existing pages; it does not replace
// them — detail pages, version publishing, and the migration wizard
// stay where they are. The server fetches the first page of each list
// via the service layer and passes it as initialData; the client
// tables own search, filters, and pagination from there (URL-as-state,
// like the standalone pages). The actor's effective role goes down so
// the UI can hide actions the actor cannot perform — the services
// enforce authorization server-side regardless.
//
// The two tables share one URL query string, but their status/sort
// enums are disjoint (PUBLISHED is not a subscription status, ACTIVE
// is not a plan status), so each table's filters are parsed with
// safeParse + schema defaults: a filter left in the URL by the other
// table falls back to unfiltered instead of 500ing the page (the
// standalone pages use .parse and would throw on it).
//
// Q3 (approved 2026-11-26): the page-level gate is VIEW_USERS —
// enforced by the proxy via the PLATFORM_ROUTE_CAPABILITY entry —
// so SUPPORT keeps access to the subscriptions half. The plans half additionally needs
// VIEW_PLAN_VERSIONS: for actors without it (SUPPORT) the Plans tab
// is hidden, the plans stat is omitted, and listPlans is never
// called (it would throw for them).
//
// No PageHeader action slot: this page has no single primary action
// (plan create lives on /admin/plans, subscription assign on
// /admin/subscriptions) — Wave 10 UX-110, do not invent one.
export default async function AdminPlansSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const raw = await searchParams
  const plansParsed = PlanListQuerySchema.safeParse(raw)
  const plansFilters = plansParsed.success
    ? plansParsed.data
    : PlanListQuerySchema.parse({})
  const subscriptionsParsed = SubscriptionListQuerySchema.safeParse(raw)
  const subscriptionsFilters = subscriptionsParsed.success
    ? subscriptionsParsed.data
    : SubscriptionListQuerySchema.parse({})

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")
  const canViewPlans = adminCan(actorRole, "VIEW_PLAN_VERSIONS")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "plans-subscriptions")

  const [stats, plansInitialData, subscriptionsInitialData] = await Promise.all(
    [
      getPlansSubscriptionsStats(session, canViewPlans),
      canViewPlans ? listPlans(session, plansFilters) : Promise.resolve(null),
      listSubscriptions(session, subscriptionsFilters),
    ]
  )

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <div
          className={`grid gap-4 sm:grid-cols-2 ${
            canViewPlans ? "lg:grid-cols-4" : "lg:grid-cols-3"
          }`}
        >
          {canViewPlans && stats.plansPublished !== null && (
            <StatCard
              title={t("statPlansPublished")}
              value={stats.plansPublished}
              icon={RiPriceTag3Line}
            />
          )}
          <StatCard
            title={t("statSubscriptionsActive")}
            value={stats.subscriptionsActive}
            icon={RiRepeatLine}
          />
          <StatCard
            title={t("statTrialing")}
            value={stats.subscriptionsTrialing}
            icon={RiTimeLine}
          />
          <StatCard
            title={t("statPastDue")}
            value={stats.subscriptionsPastDue}
            icon={RiAlertLine}
            variant="warning"
          />
        </div>
        <PlansSubscriptionsTabs
          canViewPlans={canViewPlans}
          labels={{
            plans: t("tabPlans"),
            subscriptions: t("tabSubscriptions"),
          }}
          plansTable={
            canViewPlans && plansInitialData ? (
              <PlansTable
                initialData={plansInitialData}
                filters={plansFilters}
                actorRole={actorRole}
              />
            ) : undefined
          }
          subscriptionsTable={
            <SubscriptionsTable
              initialData={subscriptionsInitialData}
              filters={subscriptionsFilters}
              actorRole={actorRole}
            />
          }
        />
      </main>
    </div>
  )
}
