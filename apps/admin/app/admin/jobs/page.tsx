import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import {
  RiAlertLine,
  RiCloseLine,
  RiInboxLine,
  RiSendPlaneLine,
  RiTimeLine,
} from "@remixicon/react"
import { StatCard } from "@sendcms/ui"
import { formatNumber } from "@sendcms/i18n"
import { getEmailQueueDepth } from "@sendcms/platform-ops"
import {
  listEmailJobsForAdmin,
  type AdminEmailJobListItem,
} from "@sendcms/notifications"
import { AdminEmailJobListQuerySchema } from "@sendcms/notifications/validators"
import {
  CronRunsQuerySchema,
  getLatestCronRun,
  listCronRuns,
  type CronRunsQuery,
} from "@sendcms/cron"
import { adminCan } from "@sendcms/permissions"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import {
  JobsQueueTable,
  type AdminEmailJobRow,
  type JobTab,
  type JobsQueueFilters,
  type JobsQueuePage,
} from "@/components/admin/jobs-queue-table"
import {
  JobsCronRunsTable,
  type CronRunRow,
  type CronRunTrigger,
} from "@/components/admin/jobs-cron-runs-table"
import {
  JobsWorkerCard,
  type JobsWorkerStatus,
} from "@/components/admin/jobs-worker-card"
import { JobsRunNowButton } from "@/components/admin/jobs-run-now-button"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "jobs")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

const TABS: JobTab[] = ["all", "pending", "sending", "failed"]

function parseTab(raw: string | string[] | undefined): JobTab {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value !== undefined && (TABS as string[]).includes(value)
    ? (value as JobTab)
    : "all"
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return toIso(value)
}

/** Serialise a service queue row for the client table (dates → ISO
    strings). The row is Stream B's `AdminEmailJobListItem`: the owner
    list's shape plus the flat `ownerName` / `ownerEmail` (the owner
    search needs them; there is no nested owner object). */
function toClientJob(row: AdminEmailJobListItem): AdminEmailJobRow {
  return {
    id: row.id,
    type: row.type,
    to: row.to,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: toIsoOrNull(row.nextAttemptAt),
    claimedAt: toIsoOrNull(row.claimedAt),
    lastError: row.lastError,
    providerMessageId: row.providerMessageId,
    deliveryStatus: row.deliveryStatus,
    deliveryUpdatedAt: toIsoOrNull(row.deliveryUpdatedAt),
    formName: row.formName,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    claimAgeMinutes: row.claimAgeMinutes,
    canRequeue: row.canRequeue,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

/** Serialise a service cron run for the client table. `steps` is the
    plan §3.6 Json blob (per-step `{ processed, sent, failed,
    skipped, errors }`, one entry per step of runEmailOutboxCron());
    anything that is not a record renders as no breakdown rather than
    a 500. */
function toClientRun(row: {
  id: string
  jobName: string
  trigger: CronRunTrigger
  triggeredById: string | null
  status: CronRunRow["status"]
  startedAt: Date | string
  finishedAt: Date | string | null
  durationMs: number | null
  steps: unknown
  createdAt: Date | string
}): CronRunRow {
  const steps =
    typeof row.steps === "object" &&
    row.steps !== null &&
    !Array.isArray(row.steps)
      ? (row.steps as CronRunRow["steps"])
      : null
  return {
    id: row.id,
    jobName: row.jobName,
    trigger: row.trigger,
    triggeredById: row.triggeredById,
    status: row.status,
    startedAt: toIso(row.startedAt),
    finishedAt: toIsoOrNull(row.finishedAt),
    durationMs: row.durationMs,
    steps,
    createdAt: toIso(row.createdAt),
  }
}

// Admin jobs page (Phase C, plan §3.6). Three sections, one page:
// the queue (StatCard row from getEmailQueueDepth + email-job table),
// the cron runs (CronRun table), and the worker (derived status
// card). The server fetches via the service layer and passes
// initialData down; the client tables own tabs, filters, and URL
// pagination. Query parsing uses the route-validated zod schemas
// (AdminEmailJobListQuerySchema / CronRunsQuerySchema), like the
// payments page uses PaymentsQuerySchema.
//
// Q9 (plan recommendation, landed by Stream B): view is VIEW_JOBS
// (all staff, Health-page parity — the proxy enforces it via the
// /admin/jobs route-capability entry); requeue + manual run need
// MANAGE_JOBS (SUPER_ADMIN + owner), enforced in the services and
// routes, with step-up re-auth before either write — the client
// tables run the shared StepUpDialog first, like the payments refund.
//
// Q12 (owner-approved): the worker card shows derived state only —
// "last seen", never "live". The last completed job is derived from
// the fetched queue page (newest-first; on the default All tab it is
// the platform's newest completed job — a filtered tab scopes it to
// that tab, and the card still labels it "last seen"). No new service
// call, no live worker fetch, no alerting (PRF-018 — Wave 11).
//
// The job detail dialog renders from the list row, so
// `getEmailJobForAdmin` is not called here — it serves the API route.
export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const raw = await searchParams
  const tab = parseTab(raw.tab)
  const queueParsed = AdminEmailJobListQuerySchema.safeParse({
    status: tab,
    type: raw.type,
    ownerSearch: raw.ownerSearch,
    page: raw.page,
  })
  const queueFilters: JobsQueueFilters = queueParsed.success
    ? queueParsed.data
    : AdminEmailJobListQuerySchema.parse({ status: tab })
  const cronParsed = CronRunsQuerySchema.safeParse({
    page: raw.cronPage,
    perPage: 20,
    status: raw.cronStatus,
    trigger: raw.cronTrigger,
  })
  const cronFilters: CronRunsQuery = cronParsed.success
    ? cronParsed.data
    : CronRunsQuerySchema.parse({})

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")
  const canManage = adminCan(actorRole, "MANAGE_JOBS")

  const [depth, queue, runs, latestRun] = await Promise.all([
    getEmailQueueDepth(),
    listEmailJobsForAdmin(session, queueFilters),
    listCronRuns(session, cronFilters),
    getLatestCronRun(session),
  ])

  const queuePage: JobsQueuePage = {
    items: queue.items.map(toClientJob),
    total: queue.total,
    page: queue.page,
    pageSize: queue.pageSize,
    counts: queue.counts,
  }
  const runsPage = {
    runs: runs.runs.map(toClientRun),
    total: runs.total,
    page: runs.page,
    perPage: runs.perPage,
    totalPages: runs.totalPages,
  }
  const latestClientRun = latestRun ? toClientRun(latestRun) : null

  const lastCompletedJob = queuePage.items.find(
    (job) => job.status === "SENT" || job.status === "FAILED"
  )
  const workerStatus: JobsWorkerStatus = {
    lastCompletedJobAt: lastCompletedJob?.updatedAt ?? null,
    lastCronRunAt: latestClientRun?.startedAt ?? null,
    lastCronRunStatus: latestClientRun?.status ?? null,
    queueDepth: {
      pending: depth.pending,
      pendingDue: depth.pendingDue,
      sending: depth.sending,
      failed: depth.failed,
    },
    stuckAgeMinutes: depth.stuckSendingAgeMinutes,
  }

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "jobs")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          canManage ? <JobsRunNowButton canManage={canManage} /> : undefined
        }
      />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            title={t("statPending")}
            value={formatNumber(locale, depth.pending)}
            icon={RiInboxLine}
            description={t("statPendingDescription")}
          />
          <StatCard
            title={t("statPendingDue")}
            value={formatNumber(locale, depth.pendingDue)}
            icon={RiTimeLine}
            description={t("statPendingDueDescription")}
          />
          <StatCard
            title={t("statSending")}
            value={formatNumber(locale, depth.sending)}
            icon={RiSendPlaneLine}
            description={t("statSendingDescription")}
          />
          <StatCard
            title={t("statFailed")}
            value={formatNumber(locale, depth.failed)}
            icon={RiCloseLine}
            variant={depth.failed > 0 ? "destructive" : "default"}
            description={t("statFailedDescription")}
          />
          <StatCard
            title={t("statStuck")}
            value={
              depth.stuckSendingAgeMinutes === null
                ? t("statStuckNone")
                : t("statStuckMinutes", {
                    minutes: depth.stuckSendingAgeMinutes,
                  })
            }
            icon={RiAlertLine}
            variant={
              depth.stuckSendingAgeMinutes === null ? "default" : "warning"
            }
            description={t("statStuckDescription")}
          />
        </div>

        <section aria-labelledby="jobs-queue-heading">
          <h2
            id="jobs-queue-heading"
            className="mb-3 text-lg font-semibold tracking-tight"
          >
            {t("queueTitle")}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("queueDescription")}
          </p>
          <JobsQueueTable
            initialData={queuePage}
            filters={queueFilters}
            tab={tab}
            canManage={canManage}
          />
        </section>

        <section aria-labelledby="jobs-cron-heading">
          <h2
            id="jobs-cron-heading"
            className="mb-3 text-lg font-semibold tracking-tight"
          >
            {t("cronTitle")}
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("cronDescription")}
          </p>
          <JobsCronRunsTable initialData={runsPage} filters={cronFilters} />
        </section>

        <section aria-labelledby="jobs-worker-heading">
          <JobsWorkerCard status={workerStatus} />
        </section>
      </main>
    </div>
  )
}
