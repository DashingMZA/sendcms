"use client"

import Link from "next/link"
import {
  useMySubscription,
  usePublishedPlans,
  useSubscribeFreePlan,
} from "@sendcms/billing/queries"
import type { SubscriptionSummary } from "@sendcms/billing/queries"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { CancelSubscription } from "./cancel-subscription"
import { PaymentHistory } from "./payment-history"
import { UsageLimits } from "./usage-limits"

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
// price, period end, cancel state) or an empty state with a
// "Take the Free plan" affordance, plus the plan limits/usage
// section (BIL-124), the payment history (BIL-092), and the cancel
// path (BIL-122 / BIL-091).
export function BillingOverview({
  locale,
  checkoutSuccess,
  initialSubscription,
}: {
  locale: string
  checkoutSuccess: boolean
  // SRC-110: server-fetched by the billing page so the plan renders
  // in the SSR HTML instead of after the client fetch.
  initialSubscription?: SubscriptionSummary | null
}) {
  const { t } = useTranslation("billing")
  const { data: subscription, isLoading } =
    useMySubscription(initialSubscription)
  const { data: plans } = usePublishedPlans()
  const subscribeFree = useSubscribeFreePlan()

  // BIL-120: the empty state's matching affordance — take the
  // published Free plan directly, without going through checkout.
  const freePlan = (plans ?? []).find(
    (plan) => plan.version.priceAmount == null || plan.version.priceAmount <= 0
  )

  async function takeFreePlan() {
    if (!freePlan) return
    try {
      await subscribeFree.mutateAsync({ planVersionId: freePlan.version.id })
    } catch {
      // The error is shown inline below; the page stays put.
    }
  }

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
              <div className="flex flex-wrap gap-2">
                {freePlan && (
                  <Button
                    onClick={takeFreePlan}
                    disabled={subscribeFree.isPending}
                  >
                    {t("takeFreePlan")}
                  </Button>
                )}
                <Button asChild variant="outline">
                  <Link href="/dashboard/billing/checkout">
                    {t("changePlan")}
                  </Link>
                </Button>
              </div>
              {subscribeFree.isError && (
                <p className="text-sm text-destructive">
                  {t("subscribeFailed")}
                </p>
              )}
              {subscribeFree.isSuccess && (
                <p className="text-sm">{t("freePlanSubscribed")}</p>
              )}
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
                    {t("currentPeriodEnds")}:{" "}
                    {new Date(subscription.currentPeriodEnd).toLocaleDateString(
                      locale
                    )}
                  </p>
                )}
                {subscription.cancelAtPeriodEnd && (
                  <p className="text-sm text-muted-foreground">
                    {t("cancelAtPeriodEndLabel")}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/dashboard/billing/checkout">
                    {t("changePlan")}
                  </Link>
                </Button>
                <CancelSubscription />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <UsageLimits />
      <PaymentHistory />
    </div>
  )
}
