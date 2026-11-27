// Email-job queue table (Phase C, plan §3.6 — thin table on the
// payments-table shape).
//
// Server-fed per tab: the page fetches the list, this component
// renders it — with the same columns, status labels, search, type
// filter, and URL pagination as the other admin tables. The detail
// dialog renders from the list row alone (every field it needs
// travels with the row); the requeue dialog hands off to the admin
// requeue route (POST /api/v1/admin/jobs/email/[jobId]/requeue, plan
// §3.6). Single action → ghost link; two actions → DropdownMenu
// (Wave 10, UX-111). The services enforce the requeue gate
// server-side regardless — canManage + row.canRequeue only hide the
// button.
//
// Bundle boundary: the row types below are local to this file. The
// page maps the service rows onto them (dates → ISO strings); this
// component never imports a service barrel.
"use client"

import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { useRequeueEmailJobForAdmin } from "@sendcms/notifications/queries"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
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
import { RiInboxLine, RiMoreLine } from "@remixicon/react"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "./plan-format"
import { JobsJobDetail } from "./jobs-job-detail"
import { StepUpDialog } from "./step-up-dialog"

export type EmailJobTypeValue =
  | "SUBMISSION_NOTIFICATION"
  | "EMAIL_VERIFICATION"
  | "PASSWORD_RESET"
  | "DIGEST"
  | "SUBMISSION_REPLY"
  | "TEST_EMAIL"

export type EmailJobStatusValue = "PENDING" | "SENDING" | "SENT" | "FAILED"

/** One queue row as the client sees it: the service row
    (`AdminEmailJobListItem`) with dates serialised to ISO strings
    (server → client props). The owner is flat (`ownerName` /
    `ownerEmail`) — Stream B's admin list carries it that way for the
    owner search; there is no nested owner object. */
export type AdminEmailJobRow = {
  id: string
  type: EmailJobTypeValue
  to: string
  subject: string
  status: EmailJobStatusValue
  attempts: number
  nextAttemptAt: string | null
  claimedAt: string | null
  lastError: string | null
  providerMessageId: string | null
  deliveryStatus: string | null
  deliveryUpdatedAt: string | null
  formName: string | null
  ownerName: string | null
  ownerEmail: string
  claimAgeMinutes: number | null
  canRequeue: boolean
  createdAt: string
  updatedAt: string
}

/** The real `listEmailJobsForAdmin` envelope: the owner list's shape
    (`items` / `pageSize` / `counts`) plus the admin rows. There is no
    `totalPages` — the table computes it from total / pageSize. */
export type JobsQueuePage = {
  items: AdminEmailJobRow[]
  total: number
  page: number
  pageSize: number
  counts: Record<"all" | "pending" | "sending" | "sent" | "failed", number>
}

export type JobsQueueFilters = {
  status: "all" | "pending" | "sending" | "failed"
  type?: EmailJobTypeValue
  ownerSearch?: string
  page: number
}

export type JobTab = "all" | "pending" | "sending" | "failed"

type Props = {
  initialData: JobsQueuePage
  filters: JobsQueueFilters
  tab: JobTab
  /** Q9 MANAGE_JOBS gate (SUPER_ADMIN + owner until Stream B lands
      the capability in @sendcms/permissions — the page computes this
      from the role; the service enforces it server-side regardless). */
  canManage: boolean
}

const TABS: JobTab[] = ["all", "pending", "sending", "failed"]

const TYPE_VALUES: EmailJobTypeValue[] = [
  "SUBMISSION_NOTIFICATION",
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "DIGEST",
  "SUBMISSION_REPLY",
  "TEST_EMAIL",
]

const TYPE_LABEL_KEYS: Record<EmailJobTypeValue, string> = {
  SUBMISSION_NOTIFICATION: "typeSubmissionNotification",
  EMAIL_VERIFICATION: "typeEmailVerification",
  PASSWORD_RESET: "typePasswordReset",
  DIGEST: "typeDigest",
  SUBMISSION_REPLY: "typeSubmissionReply",
  TEST_EMAIL: "typeTestEmail",
}

const STATUS_LABEL_KEYS: Record<EmailJobStatusValue, string> = {
  PENDING: "statusPending",
  SENDING: "statusSending",
  SENT: "statusSent",
  FAILED: "statusFailed",
}

export function JobsQueueTable({
  initialData,
  filters,
  tab,
  canManage,
}: Props) {
  const { t } = useTranslation("jobs")
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const list = initialData

  const [detailRow, setDetailRow] = useState<AdminEmailJobRow | null>(null)
  const [requeueRow, setRequeueRow] = useState<AdminEmailJobRow | null>(null)
  const [stepUpOpen, setStepUpOpen] = useState(false)

  // Requeue goes through the admin route (plan §3.6). The service
  // requires step-up re-auth (single-use, checked last before the
  // write), so the confirm button opens the shared StepUpDialog
  // first and the mutation runs only onVerified — the payments
  // refund flow, not a new pattern.
  const requeue = useRequeueEmailJobForAdmin()

  const pageCount = Math.max(1, Math.ceil(list.total / list.pageSize))
  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1
  const to = Math.min(list.total, list.page * list.pageSize)

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
      setParam("tab", nextTab === "all" ? null : nextTab)
    }
  }

  function setPage(page: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(page))
    pushParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("ownerSearch")
    next.delete("type")
    next.delete("page")
    pushParams(next)
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    setParam("ownerSearch", (data.get("ownerSearch") as string | null) ?? null)
  }

  const hasFilters = Boolean(filters.type || filters.ownerSearch)

  async function confirmRequeue() {
    if (!requeueRow) return
    try {
      await requeue.mutateAsync(requeueRow.id)
      toast.success(t("requeueToast"))
      setRequeueRow(null)
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure; the
      // dialog stays open so the admin can retry or correct it.
    }
  }

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="all">{t("tabAll")}</TabsTrigger>
          <TabsTrigger value="pending">{t("tabPending")}</TabsTrigger>
          <TabsTrigger value="sending">{t("tabSending")}</TabsTrigger>
          <TabsTrigger value="failed">{t("tabFailed")}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <form onSubmit={handleSearchSubmit} className="space-y-1">
              <Label htmlFor="jobs-search">{t("searchLabel")}</Label>
              <Input
                id="jobs-search"
                name="ownerSearch"
                defaultValue={filters.ownerSearch ?? ""}
                placeholder={t("searchPlaceholder")}
                className="h-9 w-64"
              />
            </form>
            <div className="space-y-1">
              <Label htmlFor="jobs-type-filter">{t("typeFilterLabel")}</Label>
              <Select
                value={filters.type ?? "all"}
                onValueChange={(value) =>
                  setParam("type", value === "all" ? null : value)
                }
              >
                <SelectTrigger id="jobs-type-filter" className="h-9 w-52">
                  <SelectValue placeholder={t("typeAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("typeAll")}</SelectItem>
                  {TYPE_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(TYPE_LABEL_KEYS[value])}
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
              icon={RiInboxLine}
              title={t("noJobsTitle")}
              description={
                hasFilters
                  ? t("noJobsFilteredDescription")
                  : t("noJobsDescription")
              }
            />
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colCreated")}</TableHead>
                      <TableHead>{t("colType")}</TableHead>
                      <TableHead>{t("colTo")}</TableHead>
                      <TableHead>{t("colOwner")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colAttempts")}</TableHead>
                      <TableHead>{t("colNextAttempt")}</TableHead>
                      <TableHead>{t("colClaimAge")}</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.items.map((row) => {
                      const showRequeue = canManage && row.canRequeue
                      return (
                        <TableRow key={row.id}>
                          <TableCell>
                            {formatDateTime(locale, row.createdAt)}
                          </TableCell>
                          <TableCell>{t(TYPE_LABEL_KEYS[row.type])}</TableCell>
                          <TableCell>
                            <p className="font-medium break-all">{row.to}</p>
                            <p className="text-sm text-muted-foreground">
                              {row.subject}
                            </p>
                          </TableCell>
                          <TableCell>
                            {row.ownerName ? (
                              <>
                                <p className="font-medium">{row.ownerName}</p>
                                <p className="text-sm text-muted-foreground">
                                  {row.ownerEmail}
                                </p>
                              </>
                            ) : (
                              <p className="font-medium">
                                {row.ownerEmail || t("unknownOwner")}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                row.status === "FAILED"
                                  ? "destructive"
                                  : row.status === "PENDING"
                                    ? "outline"
                                    : "secondary"
                              }
                            >
                              {t(STATUS_LABEL_KEYS[row.status])}
                            </Badge>
                          </TableCell>
                          <TableCell>{row.attempts}</TableCell>
                          <TableCell>
                            {row.nextAttemptAt
                              ? formatDateTime(locale, row.nextAttemptAt)
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {row.status === "SENDING" &&
                            row.claimAgeMinutes !== null
                              ? t("claimAgeMinutes", {
                                  minutes: row.claimAgeMinutes,
                                })
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {showRequeue ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label={t("view")}
                                  >
                                    <RiMoreLine
                                      className="size-4"
                                      aria-hidden="true"
                                    />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => setDetailRow(row)}
                                  >
                                    {t("view")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => setRequeueRow(row)}
                                  >
                                    {t("requeue")}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDetailRow(row)}
                              >
                                {t("view")}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
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

      {/* Job detail dialog — attempts/backoff timeline. */}
      <Dialog
        open={detailRow !== null}
        onOpenChange={(next) => {
          if (!next) setDetailRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {detailRow && <JobsJobDetail job={detailRow} />}
        </DialogContent>
      </Dialog>

      {/* Requeue confirmation dialog — FAILED only, or SENDING past
          the 10-minute lease (row.canRequeue, computed server-side). */}
      <Dialog
        open={requeueRow !== null}
        onOpenChange={(next) => {
          if (!next) setRequeueRow(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("requeueTitle")}</DialogTitle>
            <DialogDescription>{t("requeueDescription")}</DialogDescription>
          </DialogHeader>
          {requeueRow && (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">{t("requeueNote")}</p>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("detailTo")}</span>
                <span className="font-medium break-all">{requeueRow.to}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailSubject")}
                </span>
                <span className="font-medium">{requeueRow.subject}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailAttempts")}
                </span>
                <span>{requeueRow.attempts}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequeueRow(null)}>
              {t("requeueCancel")}
            </Button>
            <Button
              disabled={!requeueRow || requeue.isPending}
              onClick={() => setStepUpOpen(true)}
            >
              {t("requeueConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step-up: the requeue runs only after the password re-entry
          (the service requires it — single-use, checked last). */}
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmRequeue()}
      />
    </>
  )
}
