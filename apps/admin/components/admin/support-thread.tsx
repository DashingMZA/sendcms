"use client"

import Link from "next/link"
import { useState } from "react"
import type { FormEvent } from "react"
import { toast } from "sonner"
import { adminCan, type AdminRole } from "@sendcms/permissions"
import { type StaffUserRow, type TicketDetailRow } from "@sendcms/support"
import { TICKET_TRANSITIONS } from "@sendcms/support/transitions"
import {
  useAdminReplyToTicket,
  useAdminTicket,
  useAssignTicket,
  useSetTicketStatus,
} from "@sendcms/support/queries"
import type { TicketStatus } from "@sendcms/database"
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  Textarea,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "./plan-format"

const STATUS_KEYS: Record<TicketStatus, string> = {
  OPEN: "statusOpen",
  IN_PROGRESS: "statusInProgress",
  WAITING_ON_CUSTOMER: "statusWaitingOnCustomer",
  RESOLVED: "statusResolved",
  CLOSED: "statusClosed",
}

const STATUS_BADGE_VARIANT: Record<
  TicketStatus,
  "default" | "secondary" | "outline"
> = {
  OPEN: "default",
  IN_PROGRESS: "secondary",
  WAITING_ON_CUSTOMER: "outline",
  RESOLVED: "default",
  CLOSED: "secondary",
}

const PRIORITY_KEYS = {
  LOW: "priorityLow",
  NORMAL: "priorityNormal",
  HIGH: "priorityHigh",
  URGENT: "priorityUrgent",
} as const

type Props = {
  initialData: TicketDetailRow
  staffUsers: StaffUserRow[]
  actorRole: AdminRole | "PLATFORM_OWNER" | "PLATFORM_USER"
}

/**
 * The admin thread view: the full conversation, a reply form, a
 * status change (reason required; closing asks for confirmation
 * first — it is final), and assignment to a staff member. MANAGE_USERS
 * holders and SUPPORT staff can do all three; actors who can do none
 * of them get a read-only view. The service enforces the same rules
 * server-side.
 */
export function SupportThread({ initialData, staffUsers, actorRole }: Props) {
  const { t } = useTranslation("support")
  const locale = useLocale()
  const { data } = useAdminTicket(initialData.id, initialData)
  const ticket = data ?? initialData

  const canWriteTickets =
    adminCan(actorRole, "MANAGE_USERS") || actorRole === "SUPPORT"
  const reply = useAdminReplyToTicket(ticket.id)
  const setStatus = useSetTicketStatus(ticket.id)
  const assign = useAssignTicket(ticket.id)

  const [statusTarget, setStatusTarget] = useState<TicketStatus | "">("")
  const [statusReason, setStatusReason] = useState("")
  const [confirmClose, setConfirmClose] = useState(false)
  const [assigneeId, setAssigneeId] = useState("")
  const [assignReason, setAssignReason] = useState("")

  const isClosed = ticket.status === "CLOSED"
  const transitions = TICKET_TRANSITIONS[ticket.status]

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = new FormData(event.currentTarget).get("body")
    const text = typeof body === "string" ? body.trim() : ""
    if (!text) return
    try {
      await reply.mutateAsync({ body: text })
      event.currentTarget.reset()
      toast.success(t("replySent"))
    } catch {
      toast.error(t("replyFailed"))
    }
  }

  async function doStatusChange(status: TicketStatus, reason: string) {
    try {
      await setStatus.mutateAsync({ status, reason })
      setStatusTarget("")
      setStatusReason("")
      setConfirmClose(false)
      toast.success(t("statusChanged"))
    } catch {
      toast.error(t("statusChangeFailed"))
    }
  }

  function handleStatusSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!statusTarget) return
    if (!statusReason.trim()) {
      toast.error(t("statusReasonRequired"))
      return
    }
    // Closing is final — ask once, then change.
    if (statusTarget === "CLOSED") {
      setConfirmClose(true)
      return
    }
    void doStatusChange(statusTarget, statusReason.trim())
  }

  async function handleAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!assigneeId || !assignReason.trim()) return
    try {
      await assign.mutateAsync({
        assignedToId: assigneeId,
        reason: assignReason.trim(),
      })
      setAssigneeId("")
      setAssignReason("")
      toast.success(t("assignChanged"))
    } catch {
      toast.error(t("assignFailed"))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/support"
          className="text-sm underline-offset-4 hover:underline"
        >
          ← {t("backToQueue")}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE_VARIANT[ticket.status]}>
          {t(STATUS_KEYS[ticket.status])}
        </Badge>
        <Badge variant="outline">{t(PRIORITY_KEYS[ticket.priority])}</Badge>
        <span className="text-sm text-muted-foreground">
          {t("openedBy")}{" "}
          <Link
            href={`/admin/users/${ticket.userId}`}
            className="underline-offset-4 hover:underline"
          >
            {ticket.user?.name ?? ticket.user?.email ?? ticket.userId}
          </Link>
          {" · "}
          {formatDate(locale, ticket.createdAt)}
        </span>
        <span className="text-sm text-muted-foreground">
          {t("assignLabel")}:{" "}
          {ticket.assignedTo
            ? (ticket.assignedTo.name ?? ticket.assignedTo.email)
            : t("unassigned")}
        </span>
      </div>

      {!canWriteTickets && (
        <p className="text-sm text-muted-foreground">{t("readOnlyNote")}</p>
      )}

      {ticket.messages.map((message) => (
        <Card key={message.id}>
          <CardContent>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-medium">
                {message.authorId === ticket.userId
                  ? t("messageFromCustomer")
                  : t("messageFromStaff")}
              </span>
              <span className="text-sm text-muted-foreground">
                {message.author?.name ?? message.author?.email ?? ""}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatDate(locale, message.createdAt)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{message.body}</p>
          </CardContent>
        </Card>
      ))}

      {canWriteTickets && !isClosed && (
        <Card>
          <CardContent>
            <form onSubmit={handleReply} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="admin-support-reply">{t("replyTitle")}</Label>
                <Textarea
                  id="admin-support-reply"
                  name="body"
                  required
                  maxLength={2000}
                  rows={4}
                  placeholder={t("replyPlaceholder")}
                />
              </div>
              <div>
                <Button type="submit" disabled={reply.isPending}>
                  {t("replySend")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {canWriteTickets && !isClosed && (
        <>
          {transitions.length > 0 && (
            <Card>
              <CardContent>
                <form
                  onSubmit={handleStatusSubmit}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="admin-support-status">
                      {t("statusChangeTo")}
                    </Label>
                    <Select
                      value={statusTarget}
                      onValueChange={(value) =>
                        setStatusTarget(value as TicketStatus)
                      }
                    >
                      <SelectTrigger id="admin-support-status" className="w-64">
                        <SelectValue placeholder={t("statusChangeTo")} />
                      </SelectTrigger>
                      <SelectContent>
                        {transitions.map((status) => (
                          <SelectItem key={status} value={status}>
                            {t(STATUS_KEYS[status])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="admin-support-status-reason">
                      {t("statusReasonLabel")}
                    </Label>
                    <Input
                      id="admin-support-status-reason"
                      value={statusReason}
                      onChange={(event) => setStatusReason(event.target.value)}
                      required
                      maxLength={500}
                      placeholder={t("statusReasonPlaceholder")}
                    />
                  </div>
                  <div>
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={setStatus.isPending || !statusTarget}
                    >
                      {t("statusTitle")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <form onSubmit={handleAssign} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="admin-support-assignee">
                    {t("assignTitle")}
                  </Label>
                  <Select
                    value={assigneeId}
                    onValueChange={(value) => setAssigneeId(value)}
                  >
                    <SelectTrigger id="admin-support-assignee" className="w-64">
                      <SelectValue placeholder={t("assignPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {staffUsers.map((staff) => (
                        <SelectItem key={staff.id} value={staff.id}>
                          {staff.name ?? staff.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="admin-support-assign-reason">
                    {t("assignReasonLabel")}
                  </Label>
                  <Input
                    id="admin-support-assign-reason"
                    value={assignReason}
                    onChange={(event) => setAssignReason(event.target.value)}
                    required
                    maxLength={500}
                    placeholder={t("assignReasonPlaceholder")}
                  />
                </div>
                <div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={assign.isPending || !assigneeId}
                  >
                    {t("assignTitle")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}

      {isClosed && (
        <p className="text-sm text-muted-foreground">{t("replyClosedNote")}</p>
      )}

      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("closeConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("closeConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={setStatus.isPending}
              onClick={() => {
                if (statusTarget === "CLOSED") {
                  void doStatusChange("CLOSED", statusReason.trim())
                }
              }}
            >
              {t("closeConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
