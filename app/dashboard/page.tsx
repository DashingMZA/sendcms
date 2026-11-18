import Link from "next/link"
import { auth } from "@/lib/auth"
import { getDashboardOverview } from "@sendcms/analytics"
import { listFormsForUser } from "@sendcms/forms"

import { PageHeader } from "@/components/dashboard/page-header"
import { StatCard } from "@/components/dashboard/stat-card"
import { SubmissionActivityChart } from "@/components/dashboard/submission-activity-chart"
import { SubmissionStatusBadge } from "./inbox/submission-status-badge"
import { Avatar, AvatarFallback, Badge, Button, Separator } from "@sendcms/ui"

import { formatDistanceToNow } from "date-fns"
import {
  RiInboxLine,
  RiLinksLine,
  RiFileListLine,
  RiTimeLine,
  RiArrowRightLine,
} from "@remixicon/react"

export default async function OverviewPage() {
  const session = await auth()
  const userId = session!.user!.id as string
  const [overview, forms] = await Promise.all([
    getDashboardOverview(userId),
    listFormsForUser(userId),
  ])

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Summary of your domains, forms and submissions"
      />

      <div className="flex flex-col gap-8 p-8">
        {/* Stat cards */}
        <div className="grid gap-8 border-b pb-8 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Domains"
            value={overview.domainCount}
            icon={RiLinksLine}
            description={
              overview.domainCount > 0
                ? `${overview.verifiedDomainCount} verified`
                : "Add your first domain"
            }
          />
          <StatCard
            title="Forms"
            value={overview.formCount}
            icon={RiFileListLine}
            description={
              overview.formCount > 0
                ? `${overview.activeFormCount} active`
                : "Create your first form"
            }
          />
          <StatCard
            title="Submissions"
            value={overview.submissionCount}
            icon={RiInboxLine}
          />
          <StatCard
            title="Unread"
            value={overview.unreadCount}
            icon={RiTimeLine}
            variant="warning"
            description={
              overview.unreadCount > 0 ? "Needs attention" : "All caught up"
            }
          />
        </div>

        {/* Activity chart + status breakdown */}
        <div className="flex flex-wrap gap-8 border-b pb-8">
          <div className="flex w-full max-w-[750px] flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                Submission Activity
              </h2>
              <span className="text-xs text-muted-foreground">
                Last 14 days
              </span>
            </div>
            <Separator />
            <SubmissionActivityChart data={overview.activity} />
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              Status Breakdown
            </h2>
            <Separator />
            <div className="flex flex-1 flex-col justify-center gap-2 py-2">
              {overview.submissionCount === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No submissions yet.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    <span className="font-medium">{overview.unreadCount}</span>{" "}
                    unread
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{overview.spamCount}</span>{" "}
                    marked as spam
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">
                      {overview.submissionCount -
                        overview.unreadCount -
                        overview.spamCount}
                    </span>{" "}
                    read or handled
                  </p>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="mt-2 w-fit"
                  >
                    <Link href="/dashboard/inbox">
                      Open inbox <RiArrowRightLine className="size-3.5" />
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Forms list + Recent submissions */}
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                Your Forms
              </h2>
              <Button asChild variant="ghost" size="sm">
                <Link
                  href="/dashboard/forms"
                  className="flex items-center gap-1"
                >
                  View all <RiArrowRightLine className="size-3.5" />
                </Link>
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col">
              {forms.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No forms yet.{" "}
                  <Link
                    href="/dashboard/forms/new"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Create your first form
                  </Link>
                </p>
              ) : (
                forms.map((form) => (
                  <Link
                    key={form.id}
                    href={`/dashboard/forms/${form.id}`}
                    className="flex items-center gap-4 border-l-2 border-transparent py-4 transition-all hover:border-primary hover:bg-primary/5 hover:pl-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {form.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {form._count.domainLinks} domain
                        {form._count.domainLinks !== 1 ? "s" : ""} linked
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant={form.active ? "default" : "secondary"}>
                        {form.active ? "Active" : "Paused"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {form._count.submissions} submission
                        {form._count.submissions !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                Recent Submissions
              </h2>
              <Button asChild variant="ghost" size="sm">
                <Link
                  href="/dashboard/inbox"
                  className="flex items-center gap-1"
                >
                  View all <RiArrowRightLine className="size-3.5" />
                </Link>
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col">
              {overview.recentSubmissions.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No submissions yet.
                </p>
              ) : (
                overview.recentSubmissions.map((submission) => (
                  <Link
                    key={submission.id}
                    href={`/dashboard/inbox/${submission.id}`}
                    className="flex items-center gap-4 border-l-2 border-transparent py-4 transition-all hover:border-primary hover:bg-primary/5 hover:pl-3"
                  >
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback className="text-xs">
                        {(submission.senderName ?? "?")
                          .slice(0, 2)
                          .toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">
                          {submission.senderName ?? "Unknown"}
                        </p>
                        <SubmissionStatusBadge status={submission.status} />
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {submission.preview} · {submission.formName}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(submission.createdAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
