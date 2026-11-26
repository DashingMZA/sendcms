// Subscription list shell (Wave 10, SRC-118 split): the filters,
// table, and pagination. The search input and the assign/cancel
// dialogs live in ./subscriptions-table/.
"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  usePlans,
  useSubscriptions,
  type SubscriptionListQuery,
  type SubscriptionsListResponse,
} from "@sendcms/plans/queries"
import {
  Badge,
  Button,
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
} from "@sendcms/ui"
import { RiRepeatLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatPrice } from "./plan-format"
import { SubscriptionsSearchInput } from "./subscriptions-table/subscriptions-search-input"
import {
  AssignDialog,
  CancelDialog,
} from "./subscriptions-table/subscription-dialogs"

// Re-exported so existing import sites (user-package-tab) keep working
// after the split.
export { AssignDialog, CancelDialog }

type Props = {
  initialData: SubscriptionsListResponse
  filters: SubscriptionListQuery
  actorRole: PlatformRole | AdminRole
}

export function SubscriptionsTable({ initialData, filters, actorRole }: Props) {
  const { t } = useTranslation("subscriptions")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [assignOpen, setAssignOpen] = useState(false)
  const [cancelId, setCancelId] = useState<string | null>(null)

  const { data } = useSubscriptions(filters, initialData)
  const list = data ?? initialData

  const { data: plansData } = usePlans({
    page: 1,
    perPage: 100,
    sort: "createdAt:desc",
  })
  const plans = plansData?.plans ?? []

  const canManage = adminCan(actorRole, "MANAGE_SUBSCRIPTIONS")

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

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  function clearFilters() {
    router.push(pathname)
  }

  const hasFilters = Boolean(filters.status || filters.planId || filters.q)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {/* ADM-032: the search box — debounced, URL-as-state (`q`),
              now actually filtering server-side by subscriber
              name/email instead of refetching the same list. */}
          <SubscriptionsSearchInput defaultValue={filters.q ?? ""} />
          <div className="space-y-1">
            <Label htmlFor="subscriptions-status-filter">
              {t("statusFilterLabel")}
            </Label>
            <Select
              value={filters.status ?? "all"}
              onValueChange={(value) =>
                setParam("status", value === "all" ? null : value)
              }
            >
              <SelectTrigger
                id="subscriptions-status-filter"
                className="h-9 w-44"
              >
                <SelectValue placeholder={t("statusAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("statusAll")}</SelectItem>
                <SelectItem value="ACTIVE">{t("statusActive")}</SelectItem>
                <SelectItem value="TRIALING">{t("statusTrialing")}</SelectItem>
                <SelectItem value="PAST_DUE">{t("statusPastDue")}</SelectItem>
                <SelectItem value="CANCELED">{t("statusCanceled")}</SelectItem>
                <SelectItem value="EXPIRED">{t("statusExpired")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="subscriptions-plan-filter">
              {t("planFilterLabel")}
            </Label>
            <Select
              value={filters.planId ?? "all"}
              onValueChange={(value) =>
                setParam("planId", value === "all" ? null : value)
              }
            >
              <SelectTrigger
                id="subscriptions-plan-filter"
                className="h-9 w-52"
              >
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
        <div className="flex flex-wrap gap-2">
          {adminCan(actorRole, "MIGRATE_SUBSCRIPTIONS") && (
            <Button asChild variant="outline">
              <Link href="/admin/subscriptions/migrate">
                {t("migrateTitle")}
              </Link>
            </Button>
          )}
          {canManage && (
            <Button onClick={() => setAssignOpen(true)}>{t("assign")}</Button>
          )}
        </div>
      </div>

      {list.total === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
          <RiRepeatLine
            className="mb-4 size-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mb-1 text-lg font-semibold text-balance">
            {t("noSubscriptionsTitle")}
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            {hasFilters
              ? t("noSubscriptionsDescription")
              : t("noSubscriptionsEmptyDescription")}
          </p>
          {canManage && !hasFilters && (
            <Button className="mt-4" onClick={() => setAssignOpen(true)}>
              {t("assign")}
            </Button>
          )}
        </div>
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
                  <TableHead>{t("colCancelAtEnd")}</TableHead>
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
                        {subscription.planVersion.priceAmount !== null &&
                          ` · ${formatPrice(
                            locale,
                            subscription.planVersion.priceAmount,
                            subscription.planVersion.priceCurrency,
                            ""
                          )}`}
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
                        {subscriptionStatusLabel(subscription.status, t)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {subscription.currentPeriodStart
                        ? `${formatDate(locale, subscription.currentPeriodStart)} → ${formatDate(locale, subscription.currentPeriodEnd)}`
                        : t("periodNone")}
                    </TableCell>
                    <TableCell>
                      {subscription.cancelAtPeriodEnd
                        ? t("cancelAtEndYes")
                        : t("cancelAtEndNo")}
                    </TableCell>
                    <TableCell>
                      {formatDate(locale, subscription.createdAt)}
                    </TableCell>
                    <TableCell>
                      {canManage &&
                        (subscription.status === "ACTIVE" ||
                          subscription.status === "TRIALING") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCancelId(subscription.id)}
                          >
                            {t("cancel")}
                          </Button>
                        )}
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

      {assignOpen && <AssignDialog onClose={() => setAssignOpen(false)} />}
      {cancelId && (
        <CancelDialog
          subscriptionId={cancelId}
          onClose={() => setCancelId(null)}
        />
      )}
    </div>
  )
}

export function subscriptionStatusLabel(
  status: string,
  t: (key: string) => string
): string {
  switch (status) {
    case "ACTIVE":
      return t("statusActive")
    case "TRIALING":
      return t("statusTrialing")
    case "PAST_DUE":
      return t("statusPastDue")
    case "CANCELED":
      return t("statusCanceled")
    case "EXPIRED":
      return t("statusExpired")
    default:
      return status
  }
}
