// "Create coupon" action for the Coupons page header (Phase D,
// plan §3.7, Wave 10 UX-110: the PageHeader action slot holds the
// page's single primary action; no in-content duplicate).
//
// Confirmation-gated: step 1 is the form (all Q6 fields — both
// PERCENT + FIXED, optional caps + expiry + plan scoping,
// first-purchase-only, no stacking in v1), step 2 is a review
// summary; the mutation runs only from the review step. The code,
// discount type, and discount value can never change after creation,
// and the review copy says so. Create is MANAGE_BILLING
// (SUPER_ADMIN + owner only — Q10); the button renders nothing
// without canManage, and the service enforces the gate anyway.
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Button,
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
  Switch,
} from "@sendcms/ui"
import { RiAddLine } from "@remixicon/react"
import { useCreateCoupon } from "@sendcms/coupons/queries"
import type {
  CreateCouponInput,
  CreateCouponParsed,
} from "@sendcms/coupons/validators"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatAmountMinor } from "./plan-format"

const CURRENCIES = ["USD", "EUR", "GBP", "PKR"] as const

const INTERVALS = ["MONTHLY", "ANNUAL", "CUSTOM", "ONE_TIME"] as const

type DiscountType = "PERCENT" | "FIXED"

// Static record (payments-table pattern): the i18n code-usage check
// resolves a record lookup only when the record's key type is a
// literal union it can enumerate — Record<string, string> does not
// resolve.
const INTERVAL_LABEL_KEYS: Record<(typeof INTERVALS)[number], string> = {
  MONTHLY: "intervalMonthly",
  ANNUAL: "intervalAnnual",
  CUSTOM: "intervalCustom",
  ONE_TIME: "intervalOneTime",
}

export function CouponsCreateDialog({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation("coupons")
  const locale = useLocale()
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"form" | "review">("form")

  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [discountType, setDiscountType] = useState<DiscountType>("PERCENT")
  const [discountValue, setDiscountValue] = useState("")
  const [currency, setCurrency] = useState<string>("USD")
  const [maxRedemptions, setMaxRedemptions] = useState("")
  const [maxPerUser, setMaxPerUser] = useState("")
  const [validFrom, setValidFrom] = useState("")
  const [validUntil, setValidUntil] = useState("")
  const [planIds, setPlanIds] = useState("")
  const [interval, setInterval] = useState<string>("any")
  const [firstPurchaseOnly, setFirstPurchaseOnly] = useState(false)

  const createCoupon = useCreateCoupon()

  if (!canManage) return null

  function reset() {
    setStep("form")
    setCode("")
    setName("")
    setDescription("")
    setDiscountType("PERCENT")
    setDiscountValue("")
    setCurrency("USD")
    setMaxRedemptions("")
    setMaxPerUser("")
    setValidFrom("")
    setValidUntil("")
    setPlanIds("")
    setInterval("any")
    setFirstPurchaseOnly(false)
  }

  function close() {
    setOpen(false)
    reset()
  }

  // The FIXED value is entered in major units (10 = $10.00) and
  // stored in minor units — the service's CreateCouponSchema takes
  // FIXED discountValue in minor units. PERCENT is 1–100 as entered.
  function fixedValueMinor(): number | null {
    const parsed = Number.parseFloat(discountValue)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return Math.round(parsed * 100)
  }

  // buildInput always fills the defaulted fields (currency,
  // appliesToPlanIds, firstPurchaseOnly), so the built value is
  // the parsed shape — never undefined at the use sites below.
  function buildInput(): CreateCouponParsed | null {
    const trimmedCode = code.trim().toUpperCase()
    if (trimmedCode.length < 3 || /\s/.test(trimmedCode)) return null
    const value =
      discountType === "PERCENT"
        ? Number.parseInt(discountValue, 10)
        : fixedValueMinor()
    if (
      value === null ||
      !Number.isInteger(value) ||
      value < 1 ||
      (discountType === "PERCENT" && value > 100)
    ) {
      return null
    }
    const from = validFrom ? new Date(validFrom) : null
    const until = validUntil ? new Date(validUntil) : null
    if (from && until && until <= from) return null
    const maxTotal = maxRedemptions.trim()
      ? Number.parseInt(maxRedemptions, 10)
      : null
    const maxUser = maxPerUser.trim() ? Number.parseInt(maxPerUser, 10) : null
    if (
      (maxTotal !== null && (!Number.isInteger(maxTotal) || maxTotal < 1)) ||
      (maxUser !== null && (!Number.isInteger(maxUser) || maxUser < 1))
    ) {
      return null
    }
    return {
      code: trimmedCode,
      name: name.trim() ? name.trim() : null,
      description: description.trim() ? description.trim() : null,
      discountType,
      discountValue: value,
      currency,
      maxRedemptions: maxTotal,
      maxRedemptionsPerUser: maxUser,
      validFrom: from,
      validUntil: until,
      appliesToPlanIds: planIds
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
      appliesToBillingInterval:
        interval === "any"
          ? null
          : (interval as CreateCouponInput["appliesToBillingInterval"]),
      firstPurchaseOnly,
    }
  }

  const input = buildInput()
  const valueValid = input !== null

  function reviewValueLabel(): string {
    if (!input) return "—"
    if (input.discountType === "PERCENT") {
      return t("discountPercent", { value: input.discountValue })
    }
    return t("discountFixed", {
      amount: formatAmountMinor(
        locale,
        input.discountValue,
        input.currency,
        t("amountUnknown")
      ),
    })
  }

  async function confirmCreate() {
    if (!input) return
    try {
      await createCoupon.mutateAsync(input)
      toast.success(t("createToast"))
      close()
      router.refresh()
    } catch {
      // The global mutation error toast reports the failure (422
      // validation, 409 duplicate code); the dialog stays open on
      // the review step so the admin can go back and correct it.
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <RiAddLine className="size-4" aria-hidden="true" />
        {t("create")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {step === "form" ? t("createTitle") : t("reviewTitle")}
            </DialogTitle>
            <DialogDescription>
              {step === "form"
                ? t("createDescription")
                : t("reviewDescription")}
            </DialogDescription>
          </DialogHeader>

          {step === "form" ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (valueValid) setStep("review")
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="coupons-create-code">{t("formCode")}</Label>
                <Input
                  id="coupons-create-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder={t("formCodePlaceholder")}
                  className="h-9 font-mono"
                  required
                  minLength={3}
                  maxLength={50}
                />
                <p className="text-xs text-muted-foreground">
                  {t("formCodeHelp")}
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="coupons-create-name">{t("formName")}</Label>
                <Input
                  id="coupons-create-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("formNamePlaceholder")}
                  className="h-9"
                  maxLength={100}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="coupons-create-description">
                  {t("formDescription")}
                </Label>
                <Input
                  id="coupons-create-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("formDescriptionPlaceholder")}
                  className="h-9"
                  maxLength={500}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-type">
                    {t("formDiscountType")}
                  </Label>
                  <Select
                    value={discountType}
                    onValueChange={(value) =>
                      setDiscountType(value as DiscountType)
                    }
                  >
                    <SelectTrigger
                      id="coupons-create-type"
                      className="h-9 w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PERCENT">
                        {t("formDiscountTypePercent")}
                      </SelectItem>
                      <SelectItem value="FIXED">
                        {t("formDiscountTypeFixed")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="coupons-create-value">
                    {t("formDiscountValue")}
                  </Label>
                  <Input
                    id="coupons-create-value"
                    inputMode="decimal"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    className="h-9"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {discountType === "PERCENT"
                      ? t("formDiscountValuePercentHelp")
                      : t("formDiscountValueFixedHelp")}
                  </p>
                </div>
              </div>

              {discountType === "FIXED" && (
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-currency">
                    {t("formCurrency")}
                  </Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger
                      id="coupons-create-currency"
                      className="h-9 w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-max">
                    {t("formMaxRedemptions")}
                  </Label>
                  <Input
                    id="coupons-create-max"
                    inputMode="numeric"
                    value={maxRedemptions}
                    onChange={(e) => setMaxRedemptions(e.target.value)}
                    className="h-9"
                    min={1}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("formMaxRedemptionsHelp")}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-max-user">
                    {t("formMaxPerUser")}
                  </Label>
                  <Input
                    id="coupons-create-max-user"
                    inputMode="numeric"
                    value={maxPerUser}
                    onChange={(e) => setMaxPerUser(e.target.value)}
                    className="h-9"
                    min={1}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("formMaxPerUserHelp")}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-from">
                    {t("formValidFrom")}
                  </Label>
                  <Input
                    id="coupons-create-from"
                    type="datetime-local"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="coupons-create-until">
                    {t("formValidUntil")}
                  </Label>
                  <Input
                    id="coupons-create-until"
                    type="datetime-local"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                    className="h-9"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="coupons-create-plans">{t("formPlans")}</Label>
                <Input
                  id="coupons-create-plans"
                  value={planIds}
                  onChange={(e) => setPlanIds(e.target.value)}
                  placeholder={t("formPlansPlaceholder")}
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  {t("formPlansHelp")}
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="coupons-create-interval">
                  {t("formInterval")}
                </Label>
                <Select value={interval} onValueChange={setInterval}>
                  <SelectTrigger
                    id="coupons-create-interval"
                    className="h-9 w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">{t("formIntervalAny")}</SelectItem>
                    {INTERVALS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(INTERVAL_LABEL_KEYS[value])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="coupons-create-first-purchase"
                  checked={firstPurchaseOnly}
                  onCheckedChange={setFirstPurchaseOnly}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="coupons-create-first-purchase">
                    {t("formFirstPurchaseOnly")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("formFirstPurchaseOnlyHelp")}
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={close}>
                  {t("createCancel")}
                </Button>
                <Button type="submit" disabled={!valueValid}>
                  {t("createReview")}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="flex flex-col gap-4 text-sm">
              <div className="flex flex-col gap-3">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t("formCode")}</span>
                  <span className="font-mono font-medium">{input?.code}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formDiscountType")}
                  </span>
                  <span>
                    {input?.discountType === "PERCENT"
                      ? t("formDiscountTypePercent")
                      : t("formDiscountTypeFixed")}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formDiscountValue")}
                  </span>
                  <span className="font-medium">{reviewValueLabel()}</span>
                </div>
                {input?.name && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {t("formName")}
                    </span>
                    <span className="text-right">{input.name}</span>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formMaxRedemptions")}
                  </span>
                  <span>
                    {input?.maxRedemptions === null
                      ? t("detailUnlimited")
                      : input?.maxRedemptions}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formMaxPerUser")}
                  </span>
                  <span>
                    {input?.maxRedemptionsPerUser === null
                      ? t("detailUnlimited")
                      : input?.maxRedemptionsPerUser}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formPlans")}
                  </span>
                  <span>
                    {input && input.appliesToPlanIds.length === 0
                      ? t("detailAllPlans")
                      : input?.appliesToPlanIds.join(", ")}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formInterval")}
                  </span>
                  <span>
                    {input?.appliesToBillingInterval === null ||
                    input?.appliesToBillingInterval === undefined
                      ? t("formIntervalAny")
                      : t(INTERVAL_LABEL_KEYS[input.appliesToBillingInterval])}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("formFirstPurchaseOnly")}
                  </span>
                  <span>
                    {input?.firstPurchaseOnly ? t("detailYes") : t("detailNo")}
                  </span>
                </div>
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setStep("form")}
                >
                  {t("createBack")}
                </Button>
                <Button
                  disabled={!input || createCoupon.isPending}
                  onClick={() => void confirmCreate()}
                >
                  {t("createConfirm")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
