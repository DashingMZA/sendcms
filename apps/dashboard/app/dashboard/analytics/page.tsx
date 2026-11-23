import Link from "next/link"
import { auth } from "@/lib/auth"
import { getSubmissionAnalytics } from "@sendcms/analytics"

import { PageHeader } from "@/components/dashboard/page-header"
import { StatCard } from "@/components/dashboard/stat-card"
import { SubmissionActivityChart } from "@/components/dashboard/submission-activity-chart"
import {
  SUBMISSION_STATUS_LABEL_KEYS,
  SubmissionStatusBadge,
} from "../inbox/submission-status-badge"
import { Separator } from "@sendcms/ui"
import { getRequestLocale, getTranslator } from "@/lib/i18n"

import type { SubmissionStatus } from "@sendcms/database"
import {
  RiInboxLine,
  RiFileListLine,
  RiLinksLine,
  RiSpamLine,
} from "@remixicon/react"

export default async function AnalyticsPage() {
  const session = await auth()
  const analytics = await getSubmissionAnalytics(
    session!.user!.id as string,
    30
  )

  const locale = await getRequestLocale(session!.user!.id as string)
  const t = await getTranslator(locale, "analytics")

  const statusCount = (status: string) =>
    analytics.byStatus.find((row) => row.status === status)?.count ?? 0

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="flex flex-col gap-8 p-8">
        <div className="grid gap-8 border-b pb-8 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t("statTotal")}
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
            title={t("statSpam")}
            value={statusCount("SPAM")}
            icon={RiSpamLine}
            variant="destructive"
          />
        </div>

        <div className="flex w-full max-w-[750px] flex-col gap-3 border-b pb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("chartTitle")}
            </h2>
            <span className="text-xs text-muted-foreground">
              {t("chartRange")}
            </span>
          </div>
          <Separator />
          <SubmissionActivityChart
            data={analytics.byDay}
            seriesLabel={t("chartSeriesLabel")}
          />
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("byFormTitle")}
            </h2>
            <Separator />
            {analytics.byForm.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {t("noSubmissions")}
              </p>
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
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("byDomainTitle")}
            </h2>
            <Separator />
            {analytics.byDomain.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {t("noSubmissions")}
              </p>
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
          <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
            {t("byStatusTitle")}
          </h2>
          <Separator />
          {analytics.byStatus.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {t("noSubmissions")}
            </p>
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
      </div>
    </div>
  )
}
