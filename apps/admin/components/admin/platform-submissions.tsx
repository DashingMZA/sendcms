"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { PlatformSubmissionDetail } from "@sendcms/platform-ops"
import {
  usePlatformSubmission,
  usePlatformSubmissions,
  useSpamStats,
  useUpdatePlatformSubmissionStatus,
} from "@sendcms/platform-ops/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

type Props = {
  actorRole: PlatformRole | AdminRole
}

const STATUSES = ["NEW", "READ", "STARRED", "ARCHIVED", "SPAM"] as const

function formatDateTime(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * The platform submissions page (Phase 7, the abuse/SPAM queue): the
 * spam stats, the metadata-only table, the per-row status change
 * (reason required), and a detail view that loads the full
 * submission — content included — only for
 * VIEW_SENSITIVE_SUBMISSIONS holders, and only on demand (the access
 * is audit-logged by the service, as in the Phase 3 user-submission
 * reveal). The list itself never touches submission content.
 */
export function PlatformSubmissions({ actorRole }: Props) {
  const { t } = useTranslation("submissions")
  const canViewSensitive = adminCan(actorRole, "VIEW_SENSITIVE_SUBMISSIONS")
  const canChangeStatus = adminCan(actorRole, "MANAGE_USERS")

  const [status, setStatus] = useState<
    "all" | "NEW" | "READ" | "STARRED" | "ARCHIVED" | "SPAM"
  >("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<{
    id: string
    status: string
  } | null>(null)
  const [statusReason, setStatusReason] = useState("")

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { data, isLoading } = usePlatformSubmissions({
    status: status === "all" ? undefined : status,
    search: debouncedSearch || undefined,
    page,
    perPage: 20,
  })
  const { data: stats } = useSpamStats()
  // The status mutation is only invoked from the confirm handler,
  // when pendingStatus is set — so the id is correct at call time.
  const updateStatus = useUpdatePlatformSubmissionStatus(
    pendingStatus?.id ?? ""
  )

  const submissions = data?.submissions ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page

  function onSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300)
  }

  async function confirmStatus() {
    if (!pendingStatus) return
    try {
      const result = await updateStatus.mutateAsync({
        status: pendingStatus.status as "NEW" | "SPAM" | "ARCHIVED",
        reason: statusReason.trim(),
      })
      toast.success(result.changed ? t("statusChanged") : t("statusUnchanged"))
      setPendingStatus(null)
      setStatusReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("statsByStatus")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-2 text-sm">
              {stats ? (
                stats.byStatus.map(({ status: s, count }) => (
                  <div
                    key={s}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt>{s}</dt>
                    <dd className="font-semibold tabular-nums">{count}</dd>
                  </div>
                ))
              ) : (
                <Skeleton className="h-16 w-full" />
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("topFormsSpam")}</CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              stats.topSpamForms.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("none")}</p>
              ) : (
                <dl className="flex flex-col gap-2 text-sm">
                  {stats.topSpamForms.map((row) => (
                    <div
                      key={row.formId}
                      className="flex items-center justify-between gap-4"
                    >
                      <dt className="truncate">
                        {row.formName}
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.ownerEmail}
                        </span>
                      </dt>
                      <dd className="font-semibold tabular-nums">
                        {row.spamCount}
                      </dd>
                    </div>
                  ))}
                </dl>
              )
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("topUsersVolume")}</CardTitle>
          </CardHeader>
          <CardContent>
            {stats ? (
              stats.topSubmitters.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("none")}</p>
              ) : (
                <dl className="flex flex-col gap-2 text-sm">
                  {stats.topSubmitters.map((row) => (
                    <div
                      key={row.userId}
                      className="flex items-center justify-between gap-4"
                    >
                      <dt className="truncate">
                        {row.name ?? row.email}
                        {row.name && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.email}
                          </span>
                        )}
                      </dt>
                      <dd className="font-semibold tabular-nums">
                        {row.submissionsLast30Days}
                      </dd>
                    </div>
                  ))}
                </dl>
              )
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-48 space-y-1">
              <Label htmlFor="submission-status">{t("statusFilter")}</Label>
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(
                    v as
                      "all" | "NEW" | "READ" | "STARRED" | "ARCHIVED" | "SPAM"
                  )
                  setPage(1)
                }}
              >
                <SelectTrigger id="submission-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor="submission-search">{t("searchLabel")}</Label>
              <Input
                id="submission-search"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t("searchPlaceholder")}
              />
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : submissions.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noSubmissions")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colForm")}</TableHead>
                    <TableHead>{t("colUser")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colDate")}</TableHead>
                    <TableHead>{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissions.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {row.form.name}
                      </TableCell>
                      <TableCell>
                        {row.form?.owner ? (
                          <Link
                            href={`/admin/users/${row.form.owner.id}`}
                            className="text-primary hover:underline"
                          >
                            {row.form.owner.name ??
                              row.form.owner.email ??
                              row.form.owner.id}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "SPAM" ? "destructive" : "outline"
                          }
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {canViewSensitive && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedId(row.id)}
                            >
                              {t("viewContent")}
                            </Button>
                          )}
                          {canChangeStatus && (
                            <Select
                              value=""
                              onValueChange={(v) => {
                                setStatusReason("")
                                setPendingStatus({ id: row.id, status: v })
                              }}
                            >
                              <SelectTrigger className="w-36">
                                <SelectValue placeholder={t("changeStatus")} />
                              </SelectTrigger>
                              <SelectContent>
                                {["NEW", "SPAM", "ARCHIVED"].map((s) => (
                                  <SelectItem
                                    key={s}
                                    value={s}
                                    disabled={s === row.status}
                                  >
                                    {s}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t("pageOf", { page: currentPage, totalPages })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                {t("prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={currentPage >= totalPages}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("detailTitle")}</DialogTitle>
          </DialogHeader>
          {selectedId !== null && <SubmissionDetail id={selectedId} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingStatus !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingStatus(null)
            setStatusReason("")
          }
        }}
      >
        <DialogContent>
          {pendingStatus !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{t("changeStatusTitle")}</DialogTitle>
                <DialogDescription>
                  {t("changeStatusDescription", {
                    status: pendingStatus.status,
                  })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="submission-status-reason">
                  {t("reasonLabel")}
                </Label>
                <Textarea
                  id="submission-status-reason"
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {statusReason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("reasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingStatus(null)
                    setStatusReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  onClick={confirmStatus}
                  disabled={
                    updateStatus.isPending || statusReason.trim() === ""
                  }
                >
                  {t("save")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** One submission with its full content — fetched only on demand,
    only for VIEW_SENSITIVE_SUBMISSIONS holders (the parent renders
    the View button only for them). */
function SubmissionDetail({ id }: { id: string }) {
  const { t } = useTranslation("submissions")
  const { data, isLoading } = usePlatformSubmission(id)

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!data) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("noSubmissions")}
      </p>
    )
  }

  const row: PlatformSubmissionDetail = data
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("colForm")}</dt>
          <dd className="font-medium">{row.form.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("colStatus")}</dt>
          <dd>
            <Badge variant={row.status === "SPAM" ? "destructive" : "outline"}>
              {row.status}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("colDate")}</dt>
          <dd>{formatDateTime(row.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("originDomain")}</dt>
          <dd className="font-mono text-xs">{row.originDomain ?? "—"}</dd>
        </div>
      </dl>
      <div>
        <p className="mb-1 text-sm font-medium">{t("contentLabel")}</p>
        <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-4 text-xs">
          {JSON.stringify(row.data, null, 2)}
        </pre>
      </div>
    </div>
  )
}
