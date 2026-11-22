"use client"

import Link from "next/link"
import { useMySubscription } from "@sendcms/billing/queries"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

function formatPrice(
  locale: string,
  amount: number | null,
  currency: string
): string {
  if (amount == null || amount <= 0) return ""
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount / 100)
}

// The customer's billing overview: the current subscription (plan,
// price, period end) or an empty state, plus a change-plan link.
export function BillingOverview({
  locale,
  checkoutSuccess,
}: {
  locale: string
  checkoutSuccess: boolean
}) {
  const { t } = useTranslation("billing")
  const { data: subscription, isLoading } = useMySubscription()

  function intervalLabel(interval: string): string {
    if (interval === "ANNUAL") return t("perYear")
    if (interval === "MONTHLY") return t("perMonth")
    return t("oneTime")
  }

  return (
    <div className="flex flex-col gap-6">
      {checkoutSuccess && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm">{t("successNote")}</p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("currentPlan")}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !subscription ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t("noSubscription")}
              </p>
              <div>
                <Button asChild>
                  <Link href="/dashboard/billing/checkout">
                    {t("changePlan")}
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-lg font-semibold">
                  {subscription.planVersion.planName}
                </p>
                <p className="text-sm text-muted-foreground">
                  {subscription.planVersion.priceAmount != null &&
                  subscription.planVersion.priceAmount > 0
                    ? `${formatPrice(locale, subscription.planVersion.priceAmount, subscription.planVersion.priceCurrency)} ${intervalLabel(subscription.planVersion.billingInterval)}`
                    : t("priceFree")}
                </p>
                {subscription.currentPeriodEnd && (
                  <p className="text-sm text-muted-foreground">
                    {new Date(subscription.currentPeriodEnd).toLocaleDateString(
                      locale
                    )}
                  </p>
                )}
              </div>
              <div>
                <Button asChild variant="outline">
                  <Link href="/dashboard/billing/checkout">
                    {t("changePlan")}
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
