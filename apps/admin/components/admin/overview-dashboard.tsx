"use client"

import type { FormEvent } from "react"
import { useRouter } from "next/navigation"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
  Input,
  Label,
  XAxis,
  YAxis,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { useAdminOverview } from "@sendcms/platform-ops/queries"
import type { AdminOverview } from "@sendcms/platform-ops"
import type {
  OverviewQuery,
  OverviewRangeKey,
} from "@sendcms/platform-ops/validators"

const RANGES: OverviewRangeKey[] = ["24h", "7d", "30d", "90d", "12mo", "custom"]

const RANGE_KEYS: Record<
  OverviewRangeKey,
  "range24h" | "range7d" | "range30d" | "range90d" | "range12mo" | "rangeCustom"
> = {
  "24h": "range24h",
  "7d": "range7d",
  "30d": "range30d",
  "90d": "range90d",
  "12mo": "range12mo",
  custom: "rangeCustom",
}

const STATUS_KEYS = {
  NEW: "statusNew",
  READ: "statusRead",
  STARRED: "statusStarred",
  ARCHIVED: "statusArchived",
  SPAM: "statusSpam",
} as const

const USER_STATUS_KEYS = {
  ACTIVE: "statusActive",
  // DOC-003: pending users appear in the byStatus split once the
  // first PENDING_APPROVAL row exists — the key must exist or the
  // lookup throws at render time.
  PENDING_APPROVAL: "statusPendingApproval",
  SUSPENDED: "statusSuspended",
  DISABLED: "statusDisabled",
} as const

const perDayConfig: ChartConfig = {
  count: {
    label: "Submissions",
    color: "var(--chart-1)",
  },
}

const byStatusConfig: ChartConfig = {
  count: {
    label: "Submissions",
    color: "var(--chart-2)",
  },
}

function formatDayLabel(locale: string, date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  })
}

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** One small stat cell in a stat card. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/**
 * The admin overview (Phase 9, spec §3): stat cards, a submissions
 * per-day area chart, a by-status bar chart, and the active
 * subscriptions by plan. Every number comes from useAdminOverview —
 * real queries, no hardcoded stats. The range filter lives in the
 * URL, so a range is shareable and survives a reload.
 */
export function OverviewDashboard({
  initialData,
  query,
}: {
  initialData: AdminOverview
  query: OverviewQuery
}) {
  const router = useRouter()
  const { t } = useTranslation("overview")
  const locale = useLocale()
  // ADM-006: the refetch status — a range change used to keep the old
  // numbers on screen with no indicator, and a failed refetch stayed
  // silently stale (the security overview's skeleton pattern).
  const { data, isFetching, isError, refetch } = useAdminOverview(
    query,
    initialData
  )
  const overview = data ?? initialData

  function pushRange(range: OverviewRangeKey, from?: string, to?: string) {
    const params = new URLSearchParams({ range })
    if (from) params.set("from", from)
    if (to) params.set("to", to)
    router.push(`/admin?${params.toString()}`)
  }

  function handleCustomSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const from = String(formData.get("from") ?? "")
    const to = String(formData.get("to") ?? "")
    if (!from || !to) return
    pushRange("custom", from, to)
  }

  const perDay = overview.submissions.perDay.map((day) => ({
    ...day,
    label: formatDayLabel(locale, day.date),
  }))
  const byStatus = overview.submissions.byStatus.map((row) => ({
    status: t(STATUS_KEYS[row.status]),
    count: row.count,
  }))

  return (
    <div className="flex flex-col gap-6">
      {/* ADM-006: a failed refetch shows an inline error instead of
          silently stale numbers; the cards below keep the last good
          data until the retry succeeds. */}
      {isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
        >
          <span>{t("loadError")}</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((range) => (
          <Button
            key={range}
            variant={query.range === range ? "default" : "outline"}
            size="sm"
            onClick={() =>
              range === "custom"
                ? pushRange(
                    "custom",
                    toDateInput(new Date(overview.range.from)),
                    toDateInput(new Date(overview.range.to))
                  )
                : pushRange(range)
            }
          >
            {t(RANGE_KEYS[range])}
          </Button>
        ))}
        {/* ADM-006: a range change refetches — show that it is
            happening instead of silently keeping the old numbers. */}
        {isFetching && (
          <span aria-live="polite" className="text-sm text-muted-foreground">
            {t("refreshing")}
          </span>
        )}
      </div>

      {query.range === "custom" && (
        <form
          onSubmit={handleCustomSubmit}
          className="flex flex-wrap items-end gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="overview-from">{t("fromLabel")}</Label>
            <Input
              id="overview-from"
              name="from"
              type="date"
              required
              defaultValue={
                query.from ?? toDateInput(new Date(overview.range.from))
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="overview-to">{t("toLabel")}</Label>
            <Input
              id="overview-to"
              name="to"
              type="date"
              required
              defaultValue={
                query.to ?? toDateInput(new Date(overview.range.to))
              }
            />
          </div>
          <Button type="submit">{t("applyLabel")}</Button>
        </form>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("users")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("usersNew", { count: overview.users.newInRange })}
              value={String(overview.users.total)}
            />
            {/* ADM-007: the status split the API already computes
                (users.byStatus) — the early-warning numbers for
                account health — rendered on the Users card instead of
                living only in the API response. */}
            <div className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
              {overview.users.byStatus.map((row) => (
                <div
                  key={row.status}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-muted-foreground">
                    {t(USER_STATUS_KEYS[row.status])}
                  </span>
                  <span className="font-medium tabular-nums">{row.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("submissions")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("submissionsInRange", {
                count: overview.submissions.inRange,
              })}
              value={String(overview.submissions.total)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("forms")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("formsActive", { count: overview.forms.active })}
              value={String(overview.forms.total)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("domains")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("domainsVerified", {
                count: overview.domains.verified,
              })}
              value={String(overview.domains.total)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("subscriptions")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("subscriptionsActive")}
              value={String(overview.subscriptions.active)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("aiCalls")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("inRange")}
              value={String(overview.ai.callsInRange)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("mcpCalls")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat
              label={t("inRange")}
              value={String(overview.mcp.callsInRange)}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("perDayTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.submissions.perDay.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("noData")}
              </p>
            ) : (
              <ChartContainer config={perDayConfig} className="h-48 w-full">
                <AreaChart
                  data={perDay}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="overviewGradient"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="var(--chart-1)"
                        stopOpacity={0.2}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--chart-1)"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="var(--chart-1)"
                    fill="url(#overviewGradient)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("statusTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={byStatusConfig} className="h-48 w-full">
              <BarChart
                data={byStatus}
                margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="status"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="count"
                  fill="var(--chart-2)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("byPlanTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.subscriptions.byPlan.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noPlanSubscriptions")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {overview.subscriptions.byPlan.map((row) => (
                <li
                  key={row.planId}
                  className="flex items-center justify-between gap-4 rounded-md border px-4 py-3"
                >
                  <span className="font-medium">{row.planName}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {row.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
