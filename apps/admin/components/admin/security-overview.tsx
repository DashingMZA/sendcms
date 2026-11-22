"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useDeletionRequests,
  useExecuteErasure,
  useReviewDeletionRequest,
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
import { StepUpDialog } from "./step-up-dialog"

type Props = {
  actorRole: PlatformRole | AdminRole
}

const REQUEST_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
] as const

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
 * The security page (Phase 7 — deletion requests): the requests
 * table with a status filter, the review dialog (approve/reject,
 * reason required), and the erase action (only on APPROVED, reason
 * required, with a confirmation dialog that states exactly what is
 * erased and what is KEPT — audit, subscription and usage history
 * survive). Erasure anonymizes the account; the request row itself
 * is never deleted. The page is a management page (MANAGE_USERS),
 * so an actor without it gets the no-permission card and the list
 * query never fires.
 */
export function SecurityOverview({ actorRole }: Props) {
  const { t } = useTranslation("security")
  const canManage = adminCan(actorRole, "MANAGE_USERS")

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return <SecurityInner />
}

function SecurityInner() {
  const { t } = useTranslation("security")
  const [status, setStatus] = useState<
    "all" | "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED"
  >("all")
  const [page, setPage] = useState(1)

  // The request being reviewed (approve/reject): null = no dialog.
  const [pendingReview, setPendingReview] = useState<{
    id: string
    decision: "APPROVED" | "REJECTED"
  } | null>(null)
  const [reviewReason, setReviewReason] = useState("")
  // The request being erased: null = no dialog.
  const [pendingErase, setPendingErase] = useState<string | null>(null)
  const [eraseReason, setEraseReason] = useState("")
  // Step-up (Phase 9): approving a deletion + the erasure need a
  // password re-entry first. The review/erase dialog stays open
  // behind the step-up dialog; onVerified runs the same confirm.
  const [stepUpOpen, setStepUpOpen] = useState(false)
  const [stepUpTarget, setStepUpTarget] = useState<"review" | "erase" | null>(
    null
  )

  const { data, isLoading } = useDeletionRequests({
    status: status === "all" ? undefined : status,
    page,
    perPage: 20,
  })
  // Both mutations are only invoked from their confirm handlers,
  // when the pending state is set — so the id is correct at call
  // time.
  const review = useReviewDeletionRequest(pendingReview?.id ?? "")
  const erase = useExecuteErasure(pendingErase ?? "")

  const requests = data?.requests ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page

  async function confirmReview() {
    if (!pendingReview) return
    try {
      await review.mutateAsync({
        decision: pendingReview.decision,
        reason: reviewReason.trim(),
      })
      toast.success(t("reviewSaved"))
      setPendingReview(null)
      setReviewReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  async function confirmErase() {
    if (!pendingErase) return
    try {
      await erase.mutateAsync({ reason: eraseReason.trim() })
      toast.success(t("erased"))
      setPendingErase(null)
      setEraseReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  // Step-up routing: APPROVE goes through the password dialog,
  // REJECT runs straight through (it preserves the account).
  function handleReviewConfirm() {
    if (!pendingReview) return
    if (pendingReview.decision === "APPROVED") {
      setStepUpTarget("review")
      setStepUpOpen(true)
      return
    }
    void confirmReview()
  }

  function handleStepUpVerified() {
    if (stepUpTarget === "review") void confirmReview()
    else if (stepUpTarget === "erase") void confirmErase()
    setStepUpTarget(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <div className="w-48">
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(
                  v as
                    "all" | "REQUESTED" | "APPROVED" | "REJECTED" | "COMPLETED"
                )
                setPage(1)
              }}
            >
              <SelectTrigger aria-label={t("statusFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("all")}</SelectItem>
                {REQUEST_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(
                      `status${s.charAt(0)}${s.slice(1).toLowerCase()}` as "statusRequested"
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : requests.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noRequests")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colUser")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colReason")}</TableHead>
                    <TableHead>{t("colRequested")}</TableHead>
                    <TableHead>{t("colReviewed")}</TableHead>
                    <TableHead>{t("colCompleted")}</TableHead>
                    <TableHead>{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.user ? (
                          <Link
                            href={`/admin/users/${row.user.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {row.user.name ?? row.user.email}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs">
                            {row.userId}
                          </span>
                        )}
                        {row.user?.name && (
                          <p className="text-sm text-muted-foreground">
                            {row.user.email}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "COMPLETED"
                              ? "secondary"
                              : row.status === "REJECTED"
                                ? "outline"
                                : "default"
                          }
                        >
                          {t(
                            `status${row.status.charAt(0)}${row.status.slice(1).toLowerCase()}` as "statusRequested"
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-sm">
                        {row.reason}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(row.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(row.reviewedAt)}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(row.completedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {row.status === "REQUESTED" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setReviewReason("")
                                  setPendingReview({
                                    id: row.id,
                                    decision: "APPROVED",
                                  })
                                }}
                              >
                                {t("approve")}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setReviewReason("")
                                  setPendingReview({
                                    id: row.id,
                                    decision: "REJECTED",
                                  })
                                }}
                              >
                                {t("reject")}
                              </Button>
                            </>
                          )}
                          {row.status === "APPROVED" && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => {
                                setEraseReason("")
                                setPendingErase(row.id)
                              }}
                            >
                              {t("erase")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-2">
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
        open={pendingReview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingReview(null)
            setReviewReason("")
          }
        }}
      >
        <DialogContent>
          {pendingReview !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pendingReview.decision === "APPROVED"
                    ? t("approveTitle")
                    : t("rejectTitle")}
                </DialogTitle>
                <DialogDescription>
                  {pendingReview.decision === "APPROVED"
                    ? t("approveDescription")
                    : t("rejectDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="deletion-review-reason">
                  {t("reasonLabel")}
                </Label>
                <Textarea
                  id="deletion-review-reason"
                  value={reviewReason}
                  onChange={(e) => setReviewReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {reviewReason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("reasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingReview(null)
                    setReviewReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={
                    pendingReview.decision === "APPROVED"
                      ? "default"
                      : "destructive"
                  }
                  onClick={handleReviewConfirm}
                  disabled={review.isPending || reviewReason.trim() === ""}
                >
                  {pendingReview.decision === "APPROVED"
                    ? t("approve")
                    : t("reject")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingErase !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingErase(null)
            setEraseReason("")
          }
        }}
      >
        <DialogContent>
          {pendingErase !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{t("eraseTitle")}</DialogTitle>
                <DialogDescription>{t("eraseDescription")}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 text-sm">
                <div>
                  <p className="font-medium">{t("eraseDeletes")}</p>
                  <p className="text-muted-foreground">
                    {t("eraseDeletesList")}
                  </p>
                </div>
                <div>
                  <p className="font-medium">{t("eraseKeeps")}</p>
                  <p className="text-muted-foreground">{t("eraseKeepsList")}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="deletion-erase-reason">
                    {t("reasonLabel")}
                  </Label>
                  <Textarea
                    id="deletion-erase-reason"
                    value={eraseReason}
                    onChange={(e) => setEraseReason(e.target.value)}
                    placeholder={t("reasonPlaceholder")}
                    maxLength={500}
                    rows={3}
                  />
                  {eraseReason.trim() === "" && (
                    <p className="text-sm text-destructive">
                      {t("reasonRequired")}
                    </p>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingErase(null)
                    setEraseReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setStepUpTarget("erase")
                    setStepUpOpen(true)
                  }}
                  disabled={erase.isPending || eraseReason.trim() === ""}
                >
                  {t("erase")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={handleStepUpVerified}
      />
    </div>
  )
}
