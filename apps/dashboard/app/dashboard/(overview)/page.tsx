import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { getDashboardOverview } from "@sendcms/analytics"
import { listFormsForUser } from "@sendcms/forms"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { AnnouncementBanner } from "@/components/dashboard/announcement-banner"
import { SubmissionActivityChart } from "@/components/dashboard/submission-activity-chart"
import {
  SUBMISSION_STATUS_LABEL_KEYS,
  SubmissionStatusBadge,
} from "../inbox/submission-status-badge"
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  EmptyState,
  SectionHeading,
  Separator,
  StatCard,
} from "@sendcms/ui"
import { getRequestLocale, getTranslator } from "@/lib/i18n"

import { formatRelativeDate } from "@sendcms/i18n"
import {
  RiInboxLine,
  RiLinksLine,
  RiFileListLine,
  RiTimeLine,
  RiArrowRightLine,
} from "@remixicon/react"

// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "overview")
  return {
    title: t("title"),
    description: t("description"),
  }
}

export default async function OverviewPage() {
  const session = await requireDashboardSession()
  const userId = session.user.id
  const [overview, forms] = await Promise.all([
    getDashboardOverview(userId),
    listFormsForUser(userId),
  ])

  const locale = await getRequestLocale(userId)
  const t = await getTranslator(locale, "overview")

  return (
    <div>
      <AnnouncementBanner />
      <PageHeader title={t("title")} description={t("description")} />

      <PageContent>
        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t("statDomains")}
            value={overview.domainCount}
            icon={RiLinksLine}
            description={
              overview.domainCount > 0
                ? t("domainsVerified", {
                    count: overview.verifiedDomainCount,
                  })
                : t("addFirstDomain")
            }
          />
          <StatCard
            title={t("statForms")}
            value={overview.formCount}
            icon={RiFileListLine}
            description={
              overview.formCount > 0
                ? t("formsActive", { count: overview.activeFormCount })
                : t("createFirstForm")
            }
          />
          <StatCard
            title={t("statSubmissions")}
            value={overview.submissionCount}
            icon={RiInboxLine}
          />
          <StatCard
            title={t("statUnread")}
            value={overview.unreadCount}
            icon={RiTimeLine}
            variant="warning"
            description={
              overview.unreadCount > 0
                ? t("unreadNeedsAttention")
                : t("unreadAllCaughtUp")
            }
          />
        </div>

        {/* Activity chart + status breakdown */}
        <div className="flex flex-wrap gap-6 border-b pb-8">
          <div className="flex w-full max-w-[750px] flex-col gap-3">
            <div className="flex items-center justify-between">
              <SectionHeading>{t("activityTitle")}</SectionHeading>
              <span className="text-xs text-muted-foreground">
                {t("activityRange")}
              </span>
            </div>
            <Separator />
            <SubmissionActivityChart
              data={overview.activity}
              seriesLabel={t("chartSeriesLabel")}
            />
          </div>

          <div className="flex flex-col gap-3">
            <SectionHeading>{t("statusTitle")}</SectionHeading>
            <Separator />
            <div className="flex flex-1 flex-col justify-center gap-2 py-2">
              {overview.submissionCount === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noSubmissions")}
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    <span className="font-medium">{overview.unreadCount}</span>{" "}
                    {t("unreadLabel")}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{overview.spamCount}</span>{" "}
                    {t("spamLabel")}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{overview.readCount}</span>{" "}
                    {t("statusRead")}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">{overview.starredCount}</span>{" "}
                    {t("statusStarred")}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">
                      {overview.archivedCount}
                    </span>{" "}
                    {t("statusArchived")}
                  </p>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="mt-2 w-fit"
                  >
                    <Link href="/dashboard/inbox">
                      {t("openInbox")} <RiArrowRightLine className="size-3.5" />
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Forms list + Recent submissions */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <SectionHeading>{t("formsTitle")}</SectionHeading>
              <Button asChild variant="ghost" size="sm">
                <Link
                  href="/dashboard/forms"
                  className="flex items-center gap-1"
                >
                  {t("viewAll")} <RiArrowRightLine className="size-3.5" />
                </Link>
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col">
              {forms.length === 0 ? (
                <EmptyState
                  icon={RiFileListLine}
                  title={t("noFormsYet")}
                  cta={
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/dashboard/forms/new">
                        {t("createFirstForm")}
                      </Link>
                    </Button>
                  }
                />
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
                        {form._count.domainLinks === 1
                          ? t("domainsLinkedOne", {
                              count: form._count.domainLinks,
                            })
                          : t("domainsLinkedOther", {
                              count: form._count.domainLinks,
                            })}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant={form.active ? "default" : "secondary"}>
                        {form.active ? t("formActive") : t("formPaused")}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {form._count.submissions === 1
                          ? t("formSubmissionsOne", {
                              count: form._count.submissions,
                            })
                          : t("formSubmissionsOther", {
                              count: form._count.submissions,
                            })}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <SectionHeading>{t("recentTitle")}</SectionHeading>
              <Button asChild variant="ghost" size="sm">
                <Link
                  href="/dashboard/inbox"
                  className="flex items-center gap-1"
                >
                  {t("viewAll")} <RiArrowRightLine className="size-3.5" />
                </Link>
              </Button>
            </div>
            <Separator />
            <div className="flex flex-col">
              {overview.recentSubmissions.length === 0 ? (
                <EmptyState icon={RiInboxLine} title={t("noSubmissions")} />
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
                          {submission.senderName ?? t("unknownSender")}
                        </p>
                        <SubmissionStatusBadge
                          status={submission.status}
                          label={t(
                            SUBMISSION_STATUS_LABEL_KEYS[submission.status]
                          )}
                        />
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {submission.preview} · {submission.formName}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeDate(locale, submission.createdAt)}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      </PageContent>
    </div>
  )
}
