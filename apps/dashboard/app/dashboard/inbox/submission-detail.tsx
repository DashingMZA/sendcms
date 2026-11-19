"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { formatDistanceToNow, format } from "date-fns"
import {
  type InboxSubmissionDetail,
  useDeleteSubmission,
  useSubmission,
  useUpdateSubmissionStatus,
} from "@sendcms/inbox/queries"
import { getSubmissionSender } from "@sendcms/shared"

import { SubmissionStatusBadge } from "./submission-status-badge"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sendcms/ui"

import { ArrowLeft, ExternalLink, Star, Trash2 } from "lucide-react"

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Received",
  READ: "Marked as read",
  UNREAD: "Marked as unread",
  STARRED: "Starred",
  UNSTARRED: "Unstarred",
  ARCHIVED: "Archived",
  RESTORED: "Restored",
  MARKED_SPAM: "Marked as spam",
  EMAIL_SENT: "Notification email sent",
  EMAIL_FAILED: "Notification email failed",
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(formatValue).join(", ")
  return JSON.stringify(value)
}

export function SubmissionDetail({
  initialData,
}: {
  initialData: InboxSubmissionDetail
}) {
  const router = useRouter()
  const { data } = useSubmission(initialData.id, initialData)
  const submission = data ?? initialData
  const updateStatus = useUpdateSubmissionStatus()
  const deleteSubmission = useDeleteSubmission()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const markedReadRef = useRef(false)

  // Opening a new submission marks it read — once, on mount.
  useEffect(() => {
    if (
      !markedReadRef.current &&
      submission.status === "NEW" &&
      !updateStatus.isPending
    ) {
      markedReadRef.current = true
      updateStatus.mutate({ id: submission.id, action: "read" })
    }
    // Only on mount; the status in the dep list would re-trigger after
    // the mutation returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sender = getSubmissionSender(submission.data)
  const dataEntries =
    typeof submission.data === "object" &&
    submission.data !== null &&
    !Array.isArray(submission.data)
      ? Object.entries(submission.data as Record<string, unknown>)
      : []

  async function runAction(
    action: Parameters<typeof updateStatus.mutate>[0]["action"]
  ) {
    try {
      await updateStatus.mutateAsync({ id: submission.id, action })
    } catch {
      toast.error("Could not update the submission.")
    }
  }

  async function handleDelete() {
    try {
      await deleteSubmission.mutateAsync(submission.id)
      toast.success("Submission deleted.")
      router.push("/dashboard/inbox")
    } catch {
      toast.error("Could not delete the submission.")
      setConfirmDelete(false)
    }
  }

  const isStarred = submission.status === "STARRED"
  const isArchived = submission.status === "ARCHIVED"
  const isSpam = submission.status === "SPAM"

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/inbox">
            <ArrowLeft className="size-4" /> Inbox
          </Link>
        </Button>
        <h2 className="text-lg font-semibold">
          {sender.name ?? sender.email ?? "Unknown sender"}
        </h2>
        <SubmissionStatusBadge status={submission.status} />
        <span className="ml-auto flex flex-wrap gap-2">
          {submission.status === "NEW" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runAction("read")}
              disabled={updateStatus.isPending}
            >
              Mark as read
            </Button>
          )}
          {(submission.status === "READ" ||
            submission.status === "STARRED") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runAction("unread")}
              disabled={updateStatus.isPending}
            >
              Mark as unread
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAction(isStarred ? "unstar" : "star")}
            disabled={updateStatus.isPending || isArchived || isSpam}
          >
            <Star
              className={`size-3.5 ${isStarred ? "fill-amber-400 text-amber-400" : ""}`}
            />
            {isStarred ? "Unstar" : "Star"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              runAction(isArchived || isSpam ? "restore" : "archive")
            }
            disabled={updateStatus.isPending}
          >
            {isArchived || isSpam ? "Restore" : "Archive"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAction(isSpam ? "not-spam" : "spam")}
            disabled={updateStatus.isPending || isArchived}
          >
            {isSpam ? "Not spam" : "Mark as spam"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold">Submission</h3>
          <dl className="flex flex-col gap-3">
            {dataEntries.map(([key, value]) => (
              <div key={key} className="grid gap-1">
                <dt className="text-sm font-medium text-muted-foreground">
                  {key}
                </dt>
                <dd className="text-sm break-words whitespace-pre-wrap">
                  {formatValue(value)}
                </dd>
              </div>
            ))}
            {dataEntries.length === 0 && (
              <p className="text-sm text-muted-foreground">No field values.</p>
            )}
          </dl>
        </section>

        <div className="flex flex-col gap-6">
          <section className="rounded-lg border p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">Details</h3>
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Form</dt>
                <dd>
                  <Link
                    href={`/dashboard/forms/${submission.form.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {submission.form.name}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Received</dt>
                <dd title={format(new Date(submission.createdAt), "PPpp")}>
                  {formatDistanceToNow(new Date(submission.createdAt), {
                    addSuffix: true,
                  })}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Origin</dt>
                <dd>{submission.originDomain}</dd>
              </div>
              {submission.pageUrl && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Page</dt>
                  <dd className="truncate">
                    <a
                      href={submission.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                    >
                      <span className="max-w-64 truncate">
                        {submission.pageUrl}
                      </span>
                      <ExternalLink className="size-3.5 shrink-0" />
                    </a>
                  </dd>
                </div>
              )}
              {submission.ipAddress && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">IP address</dt>
                  <dd className="font-mono text-xs">{submission.ipAddress}</dd>
                </div>
              )}
              {submission.userAgent && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Browser</dt>
                  <dd
                    className="max-w-64 truncate text-xs"
                    title={submission.userAgent}
                  >
                    {submission.userAgent}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className="rounded-lg border p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">History</h3>
            {submission.events.length === 0 && (
              <p className="text-sm text-muted-foreground">No events.</p>
            )}
            <ul className="flex flex-col gap-3">
              {submission.events.map((event) => (
                <li key={event.id} className="flex items-start gap-2 text-sm">
                  <Badge variant="outline" className="shrink-0">
                    {EVENT_LABELS[event.type] ?? event.type}
                  </Badge>
                  <span className="text-muted-foreground">
                    {formatDistanceToNow(new Date(event.createdAt), {
                      addSuffix: true,
                    })}
                    {event.actor
                      ? ` · ${event.actor.name ?? event.actor.email}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this submission?</DialogTitle>
            <DialogDescription>
              This permanently deletes the submission and its history. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
