"use client"

import { useState } from "react"
import { BILLING_PROVIDERS } from "@sendcms/billing/registry"
import {
  useCreateCheckoutSession,
  useEnabledBillingProviders,
  usePublicCountries,
  usePublishedPlans,
  useSubscribeFreePlan,
} from "@sendcms/billing/queries"
import type { BillingProvider } from "@sendcms/database"
import type { PublicPlan } from "@sendcms/plans"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

type Props = {
  locale: string
  detectedCountry: string | null
  initialPlanVersionId: string | null
  cancelled: boolean
}

// The checkout flow (Phase 8): pick a plan (unless one is given),
// pick a country (pre-filled from the geo headers when available),
// pick a payment method (only providers enabled for that country),
// then continue to the provider's hosted checkout. Free plans need
// no payment and show a note instead of a button.
//
// BIL-121 (Wave 8): when the country was geo-detected, the select
// is READ-ONLY — the server enforces the detected country, so
// letting the customer pick another one would only produce a 422.
// The manual select stays only when detection returned null.
export function CheckoutManager({
  locale,
  detectedCountry,
  initialPlanVersionId,
  cancelled,
}: Props) {
  const { t } = useTranslation("billing")
  const [selectedPlanVersionId, setSelectedPlanVersionId] = useState<
    string | null
  >(initialPlanVersionId)
  const [country, setCountry] = useState<string>(detectedCountry ?? "")
  const [selectedProvider, setSelectedProvider] =
    useState<BillingProvider | null>(null)
  // Phase D (Coupons): one coupon-code input + Apply. Apply only
  // validates client-side for empty input — the code itself is
  // validated server-side when the checkout is created, and an
  // invalid code surfaces the server's 422 message in the existing
  // error UI below. Editing the input clears the applied code, so
  // a mistyped code is corrected by typing + Apply again.
  const [couponCode, setCouponCode] = useState("")
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(
    null
  )
  const [couponEmpty, setCouponEmpty] = useState(false)

  function applyCoupon() {
    const code = couponCode.trim()
    if (!code) {
      setCouponEmpty(true)
      return
    }
    setCouponEmpty(false)
    setAppliedCouponCode(code)
  }

  const { data: plans, isLoading: plansLoading } = usePublishedPlans()
  const { data: countries } = usePublicCountries()
  const { data: providers, isLoading: providersLoading } =
    useEnabledBillingProviders(country || null, { enabled: Boolean(country) })
  const createCheckout = useCreateCheckoutSession()
  const subscribeFree = useSubscribeFreePlan()

  const selectedPlan = (plans ?? []).find(
    (p) => p.version.id === selectedPlanVersionId
  )
  const isFree =
    selectedPlan != null &&
    (selectedPlan.version.priceAmount == null ||
      selectedPlan.version.priceAmount <= 0)
  // Only providers that can actually check out are offered. Gumroad
  // is registered but has no checkout API, so it never appears here.
  const payableProviders = (providers ?? []).filter(
    (p) => p.checkoutImplemented
  )

  function intervalLabel(interval: string): string {
    if (interval === "ANNUAL") return t("perYear")
    if (interval === "MONTHLY") return t("perMonth")
    return t("oneTime")
  }

  function planPrice(plan: PublicPlan): string {
    if (plan.version.priceAmount == null || plan.version.priceAmount <= 0) {
      return t("priceFree")
    }
    return `${formatPrice(locale, plan.version.priceAmount, plan.version.priceCurrency)} ${intervalLabel(plan.version.billingInterval)}`
  }

  async function takeFreePlan() {
    if (!selectedPlanVersionId) return
    try {
      await subscribeFree.mutateAsync({
        planVersionId: selectedPlanVersionId,
      })
      window.location.href = "/dashboard/billing"
    } catch {
      // The error is shown inline below; the page stays put.
    }
  }

  async function continueToPayment() {
    if (!selectedPlanVersionId || !selectedProvider) return
    try {
      const result = await createCheckout.mutateAsync({
        planVersionId: selectedPlanVersionId,
        provider: selectedProvider,
        countryCode: country || undefined,
        // Phase D: the applied coupon code, if any — the route
        // already forwards the whole body to createCheckoutSession,
        // which validates it server-side. No new route.
        ...(appliedCouponCode ? { couponCode: appliedCouponCode } : {}),
      })
      window.location.href = result.checkoutUrl
    } catch {
      // The error is shown inline below; the page stays put.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {cancelled && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm">{t("cancelledNote")}</p>
          </CardContent>
        </Card>
      )}

      {!selectedPlan && (
        <Card>
          <CardHeader>
            <CardTitle>{t("planSummary")}</CardTitle>
          </CardHeader>
          <CardContent>
            {plansLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <div className="flex flex-col gap-3">
                {(plans ?? []).map((plan) => (
                  <div
                    key={plan.id}
                    className="flex items-center justify-between gap-4 rounded-md border p-4"
                  >
                    <div>
                      <p className="font-medium">{plan.name}</p>
                      {plan.description && (
                        <p className="text-sm text-muted-foreground">
                          {plan.description}
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {planPrice(plan)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setSelectedPlanVersionId(plan.version.id)}
                    >
                      {t("selectPlan")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selectedPlan && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("planSummary")}</CardTitle>
              <CardDescription>
                {selectedPlan.name} — {planPrice(selectedPlan)}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="checkout-country">{t("countryLabel")}</Label>
                <Select
                  value={country}
                  onValueChange={setCountry}
                  disabled={detectedCountry !== null}
                >
                  <SelectTrigger id="checkout-country">
                    <SelectValue placeholder={t("countryLabel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(countries ?? []).map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {detectedCountry !== null
                    ? t("countryDetectedHint")
                    : t("countriesHint")}
                </p>
              </div>
              {!isFree && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="checkout-coupon">{t("couponLabel")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="checkout-coupon"
                      value={couponCode}
                      onChange={(e) => {
                        setCouponCode(e.target.value)
                        setAppliedCouponCode(null)
                        setCouponEmpty(false)
                      }}
                      placeholder={t("couponPlaceholder")}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={applyCoupon}
                    >
                      {t("couponApply")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {appliedCouponCode
                      ? t("couponApplied")
                      : couponEmpty
                        ? t("couponEmpty")
                        : t("couponHint")}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {country && (
            <Card>
              <CardHeader>
                <CardTitle>{t("providersTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {providersLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : payableProviders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("providersEmpty")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {payableProviders.map((p) => {
                      const definition = BILLING_PROVIDERS.find(
                        (d) => d.id === p.provider
                      )
                      const active = selectedProvider === p.provider
                      return (
                        <button
                          key={p.provider}
                          type="button"
                          onClick={() => setSelectedProvider(p.provider)}
                          className={`flex items-center justify-between gap-4 rounded-md border p-4 text-start ${
                            active ? "border-primary" : ""
                          }`}
                        >
                          <span>
                            <span className="block font-medium">
                              {definition?.label}
                            </span>
                            <span className="block text-sm text-muted-foreground">
                              {definition?.feeNote}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {isFree ? (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-6">
                <p className="text-sm">{t("freePlanNote")}</p>
                <div>
                  <Button
                    onClick={takeFreePlan}
                    disabled={subscribeFree.isPending}
                  >
                    {t("takeFreePlan")}
                  </Button>
                  {subscribeFree.isError && (
                    <p className="mt-2 text-sm text-destructive">
                      {t("subscribeFailed")}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div>
              <Button
                onClick={continueToPayment}
                disabled={
                  !selectedProvider || !country || createCheckout.isPending
                }
              >
                {t("continueToPayment")}
              </Button>
              {createCheckout.isError && (
                <p className="mt-2 text-sm text-destructive">
                  {createCheckout.error.message}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
