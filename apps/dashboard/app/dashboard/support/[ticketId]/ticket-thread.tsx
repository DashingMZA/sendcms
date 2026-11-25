"use client"

import type { FormEvent } from "react"
import { toast } from "sonner"
import { useReplyToMyTicket } from "@sendcms/support/queries"
import type { TicketDetailRow } from "@sendcms/support"
import type { TicketStatus } from "@sendcms/database"
import { Badge, Button, Card, CardContent, Label, Textarea } from "@sendcms/ui"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

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

/** The customer thread view: messages in order plus a reply form.
    A CLOSED ticket is read-only — the reply form is not rendered and
    the service would refuse a reply with 409 anyway. A reply to a
    RESOLVED ticket reopens it to OPEN (the service does this). */
export function TicketThread({ ticket }: { ticket: TicketDetailRow }) {
  const { t } = useTranslation("support")
  const locale = useLocale()
  const reply = useReplyToMyTicket(ticket.id)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const body = String(data.get("body") ?? "").trim()
    if (!body) return
    try {
      await reply.mutateAsync({ body })
      event.currentTarget.reset()
      toast.success(t("replySent"))
    } catch {
      toast.error(t("replyFailed"))
    }
  }

  const isClosed = ticket.status === "CLOSED"

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE_VARIANT[ticket.status]}>
          {t(STATUS_KEYS[ticket.status])}
        </Badge>
        <Badge variant="outline">{t(PRIORITY_KEYS[ticket.priority])}</Badge>
        <span className="text-sm text-muted-foreground">
          {t("createdLabel")}{" "}
          {formatDate(locale, ticket.createdAt, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      {ticket.messages.map((message) => (
        <Card key={message.id}>
          <CardContent>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-medium">
                {message.authorId === ticket.userId
                  ? t("youLabel")
                  : t("staffReply")}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatDate(locale, message.createdAt, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{message.body}</p>
          </CardContent>
        </Card>
      ))}

      {isClosed ? (
        <p className="text-sm text-muted-foreground">{t("replyClosedNote")}</p>
      ) : (
        <Card>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="support-reply">{t("replyTitle")}</Label>
                <Textarea
                  id="support-reply"
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
    </div>
  )
}
