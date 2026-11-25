"use client"

import { useMyBillingEvents } from "@sendcms/billing/queries"
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

// BIL-092 completion (Wave 6): the customer's own payment history —
// the webhook/billing events attributed to them, newest first. The
// server scopes the list to the caller, so only their events appear.
export function PaymentHistory() {
  const { t } = useTranslation("billing")
  const { data, isLoading, isError } = useMyBillingEvents({})

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("paymentHistoryTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }
  if (isError || !data) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("paymentHistoryTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("paymentHistoryEmpty")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.events.map((event) => (
              <div
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{event.provider}</p>
                  <p className="text-sm text-muted-foreground">
                    {event.eventType}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </p>
                </div>
                <Badge variant="secondary">
                  {event.processed ? t("processed") : t("unprocessed")}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
