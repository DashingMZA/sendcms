import Link from "next/link"
import { auth } from "@/lib/auth"
import { getSubmissionAnalytics } from "@/lib/services/dashboard-service"
import { PageHeader } from "@/components/dashboard/page-header"
import { StatCard } from "@/components/dashboard/stat-card"
import { SubmissionActivityChart } from "@/components/dashboard/submission-activity-chart"
import { SubmissionStatusBadge } from "../inbox/submission-status-badge"
import { Separator } from "@sendcms/ui"

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

  const statusCount = (status: string) =>
    analytics.byStatus.find((row) => row.status === status)?.count ?? 0

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Submissions over the last 30 days, by form, domain and status"
      />

      <div className="flex flex-col gap-8 p-8">
        <div className="grid gap-8 border-b pb-8 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Submissions (30 days)"
            value={analytics.total}
            icon={RiInboxLine}
          />
          <StatCard
            title="Forms receiving"
            value={analytics.byForm.length}
            icon={RiFileListLine}
          />
          <StatCard
            title="Origin domains"
            value={analytics.byDomain.length}
            icon={RiLinksLine}
          />
          <StatCard
            title="Spam (30 days)"
            value={statusCount("SPAM")}
            icon={RiSpamLine}
            variant="destructive"
          />
        </div>

        <div className="flex w-full max-w-[750px] flex-col gap-3 border-b pb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              Submissions per day
            </h2>
            <span className="text-xs text-muted-foreground">Last 30 days</span>
          </div>
          <Separator />
          <SubmissionActivityChart data={analytics.byDay} />
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              By form
            </h2>
            <Separator />
            {analytics.byForm.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No submissions in the last 30 days.
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
                      {row.count} submission{row.count !== 1 ? "s" : ""}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              By origin domain
            </h2>
            <Separator />
            {analytics.byDomain.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No submissions in the last 30 days.
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
                      {row.count} submission{row.count !== 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
            By status
          </h2>
          <Separator />
          {analytics.byStatus.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No submissions in the last 30 days.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {analytics.byStatus.map((row) => (
                <Link
                  key={row.status}
                  href={`/dashboard/inbox?tab=${row.status === "NEW" ? "unread" : row.status.toLowerCase()}`}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-primary/5"
                >
                  <SubmissionStatusBadge status={row.status} />
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
