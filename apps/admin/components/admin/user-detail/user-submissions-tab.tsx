// User-detail "Submissions" tab (Wave 10, SRC-118 split of
// user-detail.tsx).
//
// Submissions tab: metadata table only — the submission `data` JSON is
// never listed. Revealing one row loads the full content through the
// getUserSubmission route, which logs the sensitive-access audit event.
// The reveal button only exists for actors with
// VIEW_SENSITIVE_SUBMISSIONS.
"use client"

import { useState } from "react"
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { RiEyeLine, RiFileTextLine } from "@remixicon/react"
import {
  useAdminUserSubmission,
  useAdminUserSubmissions,
} from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate, formatDateTime } from "../plan-format"
import { EmptyState } from "./shared"

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  return JSON.stringify(value)
}

export function UserSubmissionsTab({
  userId,
  canReveal,
}: {
  userId: string
  canReveal: boolean
}) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const [page, setPage] = useState(1)
  const [revealId, setRevealId] = useState<string | null>(null)
  const { data } = useAdminUserSubmissions(userId, page)
  const submissions = data?.submissions ?? []
  const total = data?.total ?? 0
  const perPage = data?.perPage ?? 20
  const currentPage = data?.page ?? page
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const from = total === 0 ? 0 : (currentPage - 1) * perPage + 1
  const to = Math.min(total, currentPage * perPage)

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{t("submissionsTitle")}</CardTitle>
        <CardDescription>{t("submissionsMaskedNote")}</CardDescription>
        {!canReveal && (
          <CardDescription>{t("submissionsNoReveal")}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {submissions.length === 0 ? (
          <EmptyState
            icon={
              <RiFileTextLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title={t("submissionsEmptyTitle")}
            description={t("submissionsEmptyDescription")}
          />
        ) : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("submissionForm")}</TableHead>
                    <TableHead>{t("submissionStatus")}</TableHead>
                    <TableHead>{t("submissionCreated")}</TableHead>
                    <TableHead>{t("submissionOrigin")}</TableHead>
                    {canReveal && <TableHead className="w-24" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissions.map((submission) => (
                    <TableRow key={submission.id}>
                      <TableCell className="font-medium">
                        {submission.formName}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{submission.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {formatDate(locale, submission.createdAt)}
                      </TableCell>
                      <TableCell>{submission.originDomain}</TableCell>
                      {canReveal && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevealId(submission.id)}
                          >
                            <RiEyeLine className="size-4" aria-hidden="true" />
                            {t("submissionReveal")}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{t("showing", { from, to, total })}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t("previous")}
                </Button>
                <span className="self-center">
                  {t("pageOf", { page: currentPage, totalPages: pageCount })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t("next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
      {revealId !== null && (
        <SubmissionRevealDialog
          userId={userId}
          submissionId={revealId}
          onClose={() => setRevealId(null)}
        />
      )}
    </Card>
  )
}

/** Full submission content, loaded on demand (one reveal = one audit event). */
function SubmissionRevealDialog({
  userId,
  submissionId,
  onClose,
}: {
  userId: string
  submissionId: string
  onClose: () => void
}) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const { t: tErrors } = useTranslation("errors")
  const { data, isPending, isError } = useAdminUserSubmission(
    userId,
    submissionId
  )
  const entries = data ? Object.entries(data.data) : []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle>{t("revealTitle")}</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.form.name} · ${formatDateTime(locale, data.createdAt)} · ${data.originDomain}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-destructive">{tErrors("generic")}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("revealNoData")}</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("revealField")}</TableHead>
                  <TableHead>{t("revealValue")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(([field, value]) => (
                  <TableRow key={field}>
                    <TableCell className="font-medium">{field}</TableCell>
                    <TableCell className="break-all">
                      {formatFieldValue(value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
