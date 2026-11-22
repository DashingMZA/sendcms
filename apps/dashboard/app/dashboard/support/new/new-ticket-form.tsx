"use client"

import { useState } from "react"
import type { FormEvent } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useCreateTicket } from "@sendcms/support/queries"
import type { TicketPriority } from "@sendcms/database"
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

const PRIORITY_KEYS = {
  LOW: "priorityLow",
  NORMAL: "priorityNormal",
  HIGH: "priorityHigh",
  URGENT: "priorityUrgent",
} as const

/** The new-ticket form. On success the customer lands on the new
    thread, where the conversation continues. */
export function NewTicketForm() {
  const { t } = useTranslation("support")
  const router = useRouter()
  const createTicket = useCreateTicket()
  const [priority, setPriority] = useState<TicketPriority>("NORMAL")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const subject = String(data.get("subject") ?? "").trim()
    const body = String(data.get("body") ?? "").trim()
    if (!subject || !body) return
    try {
      const ticket = await createTicket.mutateAsync({
        subject,
        body,
        priority,
      })
      toast.success(t("createTicketSuccess"))
      router.push(`/dashboard/support/${ticket.id}`)
    } catch {
      toast.error(t("createTicketFailed"))
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-subject">{t("subjectLabel")}</Label>
            <Input
              id="support-subject"
              name="subject"
              required
              maxLength={200}
              placeholder={t("subjectPlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-priority">{t("colPriority")}</Label>
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as TicketPriority)}
            >
              <SelectTrigger id="support-priority" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["LOW", "NORMAL", "HIGH", "URGENT"] as TicketPriority[]).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {t(PRIORITY_KEYS[value])}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-body">{t("bodyLabel")}</Label>
            <Textarea
              id="support-body"
              name="body"
              required
              maxLength={2000}
              rows={6}
              placeholder={t("bodyPlaceholder")}
            />
          </div>
          <div>
            <Button type="submit" disabled={createTicket.isPending}>
              {t("createTicket")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
