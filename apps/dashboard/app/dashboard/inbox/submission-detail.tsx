"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { formatDate, formatRelativeDate, formatTime } from "@sendcms/i18n"
import {
  type InboxSubmissionDetail,
  useDeleteSubmission,
  useDraftReply,
  useSendReply,
  useSubmission,
  useUpdateSubmissionStatus,
} from "@sendcms/inbox/queries"
import { getSubmissionSender, ApiClientError } from "@sendcms/shared"

import {
  SUBMISSION_STATUS_LABEL_KEYS,
  SubmissionStatusBadge,
} from "./submission-status-badge"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

import { ArrowLeft, ExternalLink, Star, Trash2 } from "lucide-react"

/** Translation key (inbox domain) for each submission event type.
    An event type with no key here renders its raw type value. */
const EVENT_LABEL_KEYS: Record<string, string> = {
  CREATED: "eventReceived",
  READ: "eventMarkedRead",
  UNREAD: "eventMarkedUnread",
  STARRED: "eventStarred",
  UNSTARRED: "eventUnstarred",
  ARCHIVED: "eventArchived",
  RESTORED: "eventRestored",
  MARKED_SPAM: "eventMarkedSpam",
  EMAIL_SENT: "eventEmailSent",
  EMAIL_FAILED: "eventEmailFailed",
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
  const { t } = useTranslation("inbox")
  const locale = useLocale()
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
      toast.error(t("updateFailed"))
    }
  }

  async function handleDelete() {
    try {
      await deleteSubmission.mutateAsync(submission.id)
      toast.success(t("deleteSuccess"))
      router.push("/dashboard/inbox")
    } catch {
      toast.error(t("deleteFailed"))
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
            <ArrowLeft className="size-4" /> {t("backToInbox")}
          </Link>
        </Button>
        <h2 className="text-lg font-semibold">
          {sender.name ?? sender.email ?? t("unknownSender")}
        </h2>
        <SubmissionStatusBadge
          status={submission.status}
          label={t(SUBMISSION_STATUS_LABEL_KEYS[submission.status])}
        />
        <span className="ml-auto flex flex-wrap gap-2">
          {submission.status === "NEW" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runAction("read")}
              disabled={updateStatus.isPending}
            >
              {t("markAsRead")}
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
              {t("markAsUnread")}
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
            {isStarred ? t("unstar") : t("star")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              runAction(isArchived || isSpam ? "restore" : "archive")
            }
            disabled={updateStatus.isPending}
          >
            {isArchived || isSpam ? t("restore") : t("archive")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAction(isSpam ? "not-spam" : "spam")}
            disabled={updateStatus.isPending || isArchived}
          >
            {isSpam ? t("notSpam") : t("markAsSpam")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-3.5" /> {t("delete")}
          </Button>
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border p-4 sm:p-6">
          <h3 className="mb-4 text-base font-semibold">
            {t("submissionSection")}
          </h3>
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
              <p className="text-sm text-muted-foreground">
                {t("noFieldValues")}
              </p>
            )}
          </dl>
        </section>

        <div className="flex flex-col gap-6">
          <section className="rounded-lg border p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">
              {t("detailsSection")}
            </h3>
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("detailsForm")}</dt>
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
                <dt className="text-muted-foreground">
                  {t("detailsReceived")}
                </dt>
                <dd
                  title={`${formatDate(locale, submission.createdAt)} ${formatTime(locale, submission.createdAt)}`}
                >
                  {formatRelativeDate(locale, submission.createdAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("detailsOrigin")}</dt>
                <dd>{submission.originDomain}</dd>
              </div>
              {submission.pageUrl && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t("detailsPage")}</dt>
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
                  <dt className="text-muted-foreground">
                    {t("detailsIpAddress")}
                  </dt>
                  <dd className="font-mono text-xs">{submission.ipAddress}</dd>
                </div>
              )}
              {submission.userAgent && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {t("detailsBrowser")}
                  </dt>
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
            <h3 className="mb-4 text-base font-semibold">
              {t("historySection")}
            </h3>
            {submission.events.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("noEvents")}</p>
            )}
            <ul className="flex flex-col gap-3">
              {submission.events.map((event) => (
                <li key={event.id} className="flex items-start gap-2 text-sm">
                  <Badge variant="outline" className="shrink-0">
                    {EVENT_LABEL_KEYS[event.type]
                      ? t(EVENT_LABEL_KEYS[event.type])
                      : event.type}
                  </Badge>
                  <span className="text-muted-foreground">
                    {formatRelativeDate(locale, event.createdAt)}
                    {event.actor
                      ? ` · ${event.actor.name ?? event.actor.email}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <ReplySection submission={submission} />
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Reply composer (Phase 12, Step 4; decoupled from AI in Phase 16,
    EML-091). The composer is the owner's way to answer a visitor:
    it renders for any form with a sender email, and the owner writes
    the reply directly. AI is an enhancement inside it ("Suggest
    with AI"), not a gate — the draft-then-send flow is unchanged
    for AI-enabled forms. Nothing is sent until the owner clicks
    "Send reply". */
function ReplySection({ submission }: { submission: InboxSubmissionDetail }) {
  const { t } = useTranslation("inbox")
  const sender = getSubmissionSender(submission.data)
  const draft = useDraftReply(submission.id)
  const send = useSendReply(submission.id)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [sent, setSent] = useState(false)

  // EML-091: only a missing sender email hides the composer — a
  // form without AI still gets a reply box. (Hooks above stay
  // unconditional: the early return must never sit above them.)
  if (!sender.email) return null
  const aiEnabled = submission.form.aiEnabled

  const onDraft = async () => {
    setSent(false)
    try {
      const result = await draft.mutateAsync()
      setSubject(result.subject)
      setBody(result.body)
    } catch (err) {
      // DSH-303: mirror AiFieldsPanel — the server's reason (in
      // particular the expected 503s: no provider configured, AI
      // disabled) reaches the toast; the generic string is only the
      // fallback for non-API errors.
      toast.error(
        err instanceof ApiClientError ? err.message : t("draftFailed")
      )
    }
  }

  const onSend = async () => {
    try {
      await send.mutateAsync({ subject, body })
      setSent(true)
      toast.success(t("replyQueued"))
    } catch (err) {
      // DSH-303: same as onDraft — surface the server's reason.
      toast.error(err instanceof ApiClientError ? err.message : t("sendFailed"))
    }
  }

  return (
    <section className="rounded-lg border p-4 sm:p-6">
      <h3 className="mb-2 text-base font-semibold">{t("replySection")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("replyDescription", { email: sender.email })}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        <div>
          <Button
            variant="outline"
            onClick={onDraft}
            disabled={!aiEnabled || draft.isPending || send.isPending}
          >
            {draft.isPending ? t("drafting") : t("suggestWithAi")}
          </Button>
        </div>
        {!aiEnabled && (
          <p className="text-sm text-muted-foreground">
            {t("suggestAiDisabled")}
          </p>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="reply-subject">{t("subjectLabel")}</Label>
          <Input
            id="reply-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="reply-body">{t("bodyLabel")}</Label>
          <Textarea
            id="reply-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
          />
        </div>
        <div>
          <Button
            onClick={onSend}
            disabled={!subject.trim() || !body.trim() || send.isPending}
          >
            {send.isPending ? t("sending") : t("sendReply")}
          </Button>
        </div>
      </div>
      {sent && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("replyQueuedNote")}
        </p>
      )}
    </section>
  )
}
