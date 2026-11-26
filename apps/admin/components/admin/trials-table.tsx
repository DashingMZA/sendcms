// Trials table (Phase A, plan §3.4 — thin trial table on the
// subscriptions-table shape).
//
// Reuse-first, and why this is thin instead of the existing
// SubscriptionsTable: that table's refetch path (useSubscriptions →
// GET /api/v1/admin/subscriptions with a single `status`) cannot
// express the Expiring tab (a currentPeriodEnd bound) or the Ended
// tab (trial-origin subscriptions in EXPIRED + CANCELED). So this
// table is server-fed per tab — the page fetches the list, this
// component renders it — with the same columns, period cell, status
// labels, search, plan filter, and URL pagination as
// SubscriptionsTable. It is read-only and has no mutations, so there
// is no React Query cache to invalidate; URL navigation re-renders
// server data. Trial actions (cancel, extend, convert) are NOT new
// in v1: each row links to the existing subscription detail (the
// subscriber's user Package tab, which hosts the Cancel dialog).
// Single action → ghost link (Wave 10, UX-111).
"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Badge,
  Button,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sendcms/ui"
import { RiRepeatLine } from "@remixicon/react"
import type {
  PlanSummary,
  SubscriptionListQuery,
  SubscriptionsListResponse,
} from "@sendcms/plans/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "./plan-format"
import { SubscriptionsSearchInput } from "./subscriptions-table/subscriptions-search-input"
import { subscriptionStatusLabel } from "./subscriptions-table"

export type TrialTab = "active" | "expiring" | "ended"

type Props = {
  initialData: SubscriptionsListResponse
  filters: SubscriptionListQuery
  tab: TrialTab
  plans: PlanSummary[]
}

const TABS: TrialTab[] = ["active", "expiring", "ended"]

export function TrialsTable({ initialData, filters, tab, plans }: Props) {
  const { t } = useTranslation("trials")
  const { t: tSubscriptions } = useTranslation("subscriptions")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const list = initialData

  const pageCount = Math.max(1, Math.ceil(list.total / list.perPage))
  const from = list.total === 0 ? 0 : (list.page - 1) * list.perPage + 1
  const to = Math.min(list.total, list.page * list.perPage)

  function pushParams(next: URLSearchParams) {
    const text = next.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (value === null || value === "") {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    next.delete("page")
    pushParams(next)
  }

  function setTab(nextTab: string) {
    if ((TABS as string[]).includes(nextTab)) {
      setParam("tab", nextTab === "active" ? null : nextTab)
    }
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("q")
    next.delete("planId")
    next.delete("page")
    pushParams(next)
  }

  const hasFilters = Boolean(filters.planId || filters.q)
  const emptyDescription =
    tab === "expiring"
      ? t("noTrialsExpiringDescription")
      : tab === "ended"
        ? t("noTrialsEndedDescription")
        : t("noTrialsActiveDescription")

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="active">{t("tabActive")}</TabsTrigger>
        <TabsTrigger value="expiring">{t("tabExpiring")}</TabsTrigger>
        <TabsTrigger value="ended">{t("tabEnded")}</TabsTrigger>
      </TabsList>

      <TabsContent value={tab} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <SubscriptionsSearchInput defaultValue={filters.q ?? ""} />
          <div className="space-y-1">
            <Label htmlFor="trials-plan-filter">{t("planFilterLabel")}</Label>
            <Select
              value={filters.planId ?? "all"}
              onValueChange={(value) =>
                setParam("planId", value === "all" ? null : value)
              }
            >
              <SelectTrigger id="trials-plan-filter" className="h-9 w-52">
                <SelectValue placeholder={t("planAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("planAll")}</SelectItem>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id}>
                    {plan.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          )}
        </div>

        {list.total === 0 ? (
          <EmptyState
            icon={RiRepeatLine}
            title={t("noTrialsTitle")}
            description={
              hasFilters ? t("noTrialsFilteredDescription") : emptyDescription
            }
          />
        ) : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colUser")}</TableHead>
                    <TableHead>{t("colPlan")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colPeriod")}</TableHead>
                    <TableHead>{t("colCreated")}</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.subscriptions.map((subscription) => (
                    <TableRow key={subscription.id}>
                      <TableCell>
                        <p className="font-medium">
                          {subscription.user.name ?? "—"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {subscription.user.email}
                        </p>
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{subscription.plan.name}</p>
                        <p className="text-sm text-muted-foreground">
                          v{subscription.planVersion.version}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            subscription.status === "ACTIVE" ||
                            subscription.status === "TRIALING"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {subscriptionStatusLabel(
                            subscription.status,
                            tSubscriptions
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {subscription.currentPeriodStart
                          ? `${formatDate(locale, subscription.currentPeriodStart)} → ${formatDate(locale, subscription.currentPeriodEnd)}`
                          : tSubscriptions("periodNone")}
                      </TableCell>
                      <TableCell>
                        {formatDate(locale, subscription.createdAt)}
                      </TableCell>
                      <TableCell>
                        {/* The existing subscription detail is the
                            subscriber's user Package tab (cancel /
                            extend live there). /admin/users/[id]
                            redirects to /admin/all-users/[id]. */}
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            href={`/admin/all-users/${subscription.userId}`}
                          >
                            {t("view")}
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t("showing", { from, to, total: list.total })}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={list.page <= 1}
                  onClick={() => setPage(list.page - 1)}
                >
                  {t("previous")}
                </Button>
                <span className="self-center">
                  {t("pageOf", { page: list.page, totalPages: pageCount })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={list.page >= pageCount}
                  onClick={() => setPage(list.page + 1)}
                >
                  {t("next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </TabsContent>
    </Tabs>
  )
}
