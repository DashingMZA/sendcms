import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { getSubmissionAnalytics } from "@sendcms/analytics"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { SubmissionActivityChart } from "@/components/dashboard/submission-activity-chart"
import {
  SUBMISSION_STATUS_LABEL_KEYS,
  SubmissionStatusBadge,
} from "../inbox/submission-status-badge"
import { EmptyState, SectionHeading, Separator, StatCard } from "@sendcms/ui"
import { getRequestLocale, getTranslator } from "@/lib/i18n"

import type { SubmissionStatus } from "@sendcms/database"
import {
  RiInboxLine,
  RiFileListLine,
  RiLinksLine,
  RiSpamLine,
} from "@remixicon/react"

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const session = await requireDashboardSession()
  // DSH-407: the range comes from `?days=` (7 / 30 / 90); anything
  // else falls back to the 30-day default.
  const rawDays = (await searchParams).days
  const days = rawDays === "7" || rawDays === "90" ? Number(rawDays) : 30
  const analytics = await getSubmissionAnalytics(session.user.id, days)

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "analytics")

  const statusCount = (status: string) =>
    analytics.byStatus.find((row) => row.status === status)?.count ?? 0

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("descriptionDays", { days })}
      />

      <PageContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t("statTotalDays", { days })}
            value={analytics.total}
            icon={RiInboxLine}
          />
          <StatCard
            title={t("statForms")}
            value={analytics.byForm.length}
            icon={RiFileListLine}
          />
          <StatCard
            title={t("statDomains")}
            value={analytics.byDomain.length}
            icon={RiLinksLine}
          />
          <StatCard
            title={t("statSpamDays", { days })}
            value={statusCount("SPAM")}
            icon={RiSpamLine}
            variant="destructive"
          />
        </div>

        <div className="flex w-full max-w-[750px] flex-col gap-3 border-b pb-8">
          <div className="flex items-center justify-between">
            <SectionHeading>{t("chartTitle")}</SectionHeading>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("rangeLabel")}</span>
              {[7, 30, 90].map((range) => (
                <Link
                  key={range}
                  href={`/dashboard/analytics?days=${range}`}
                  aria-current={range === days ? "true" : undefined}
                  className={`rounded-md border px-2 py-1 ${
                    range === days
                      ? "border-primary bg-accent font-medium text-foreground"
                      : "hover:bg-accent"
                  }`}
                >
                  {t("rangeDays", { days: range })}
                </Link>
              ))}
            </span>
          </div>
          <Separator />
          <SubmissionActivityChart
            data={analytics.byDay}
            seriesLabel={t("chartSeriesLabel")}
          />
          <p className="text-xs text-muted-foreground">
            {t("chartRangeDays", { days })}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <SectionHeading>{t("byFormTitle")}</SectionHeading>
            <Separator />
            {analytics.byForm.length === 0 ? (
              <EmptyState
                icon={RiInboxLine}
                title={t("noSubmissionsDays", { days })}
              />
            ) : (
              <div className="flex flex-col">
                {analytics.byForm.map((row) => (
                  <Link
                    key={row.formId}
                    href={`/dashboard/forms/${row.formId}`}
                    className="flex items-center justify-between border-l-2 border-transparent py-3 transition-all hover:border-primary hover:bg-primary/5 hover:pl-3"
                  >
                    <span className="truncate text-sm font-medium">
                      {row.formName}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {row.count === 1
                        ? t("submissionsCountOne", { count: row.count })
                        : t("submissionsCountOther", { count: row.count })}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <SectionHeading>{t("byDomainTitle")}</SectionHeading>
            <Separator />
            {analytics.byDomain.length === 0 ? (
              <EmptyState
                icon={RiInboxLine}
                title={t("noSubmissionsDays", { days })}
              />
            ) : (
              <div className="flex flex-col">
                {analytics.byDomain.map((row) => (
                  <div
                    key={row.domain}
                    className="flex items-center justify-between py-3"
                  >
                    <span className="truncate font-mono text-sm">
                      {row.domain}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {row.count === 1
                        ? t("submissionsCountOne", { count: row.count })
                        : t("submissionsCountOther", { count: row.count })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <SectionHeading>{t("byStatusTitle")}</SectionHeading>
          <Separator />
          {analytics.byStatus.length === 0 ? (
            <EmptyState
              icon={RiInboxLine}
              title={t("noSubmissionsDays", { days })}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {analytics.byStatus.map((row) => (
                <Link
                  key={row.status}
                  href={`/dashboard/inbox?tab=${row.status === "NEW" ? "unread" : row.status.toLowerCase()}`}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-primary/5"
                >
                  <SubmissionStatusBadge
                    status={row.status as SubmissionStatus}
                    label={t(
                      SUBMISSION_STATUS_LABEL_KEYS[
                        row.status as SubmissionStatus
                      ]
                    )}
                  />
                  <span className="font-medium">{row.count}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </PageContent>
    </div>
  )
}
