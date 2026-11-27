// Coupon detail dialog (Phase D, plan §3.7). Rendered only with
// a real coupon id, so useCoupon / useCouponRedemptions always get
// a string id (their hooks take no null). Shows the coupon fields
// plus the redemptions table, newest first, paginated.
"use client"

import Link from "next/link"
import { useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { RiCouponLine } from "@remixicon/react"
import { useCoupon, useCouponRedemptions } from "@sendcms/coupons/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatAmountMinor, formatDate } from "./plan-format"
import { couponDiscountLabel } from "./coupons-table"

const STATUS_LABEL_KEYS: Record<"ACTIVE" | "DISABLED" | "EXPIRED", string> = {
  ACTIVE: "statusActive",
  DISABLED: "statusDisabled",
  EXPIRED: "statusExpired",
}

const INTERVAL_LABEL_KEYS: Record<
  "MONTHLY" | "ANNUAL" | "CUSTOM" | "ONE_TIME",
  string
> = {
  MONTHLY: "intervalMonthly",
  ANNUAL: "intervalAnnual",
  CUSTOM: "intervalCustom",
  ONE_TIME: "intervalOneTime",
}

type Props = {
  couponId: string
  onClose: () => void
}

export function CouponsDetailDialog({ couponId, onClose }: Props) {
  const { t } = useTranslation("coupons")
  const locale = useLocale()

  const [redemptionPage, setRedemptionPage] = useState(1)

  const detail = useCoupon(couponId)
  const redemptions = useCouponRedemptions(couponId, redemptionPage, 20)

  const detailData = detail.data ?? null
  const redemptionData = redemptions.data ?? null

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("detailTitle")}</DialogTitle>
        </DialogHeader>
        {detail.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : detail.isError || !detailData ? (
          <p className="text-sm text-muted-foreground">
            {t("detailLoadError")}
          </p>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-3">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("colCode")}</span>
                <span className="font-mono font-medium">{detailData.code}</span>
              </div>
              {detailData.name && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("detailName")}
                  </span>
                  <span className="text-right font-medium">
                    {detailData.name}
                  </span>
                </div>
              )}
              {detailData.description && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t("detailDescription")}
                  </span>
                  <span className="text-right">{detailData.description}</span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailDiscount")}
                </span>
                <span className="font-medium">
                  {couponDiscountLabel(detailData, locale, t)}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailStatus")}
                </span>
                <span>
                  {t(
                    STATUS_LABEL_KEYS[
                      detailData.status as keyof typeof STATUS_LABEL_KEYS
                    ]
                  )}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailMaxRedemptions")}
                </span>
                <span>
                  {detailData.maxRedemptions === null
                    ? t("detailUnlimited")
                    : detailData.maxRedemptions}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailMaxPerUser")}
                </span>
                <span>
                  {detailData.maxRedemptionsPerUser === null
                    ? t("detailUnlimited")
                    : detailData.maxRedemptionsPerUser}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailValidFrom")}
                </span>
                <span>{formatDate(locale, detailData.validFrom)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailValidUntil")}
                </span>
                <span>{formatDate(locale, detailData.validUntil)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailPlans")}
                </span>
                <span>
                  {detailData.appliesToPlanIds.length === 0
                    ? t("detailAllPlans")
                    : detailData.appliesToPlanIds.join(", ")}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailInterval")}
                </span>
                <span>
                  {detailData.appliesToBillingInterval === null ||
                  !(detailData.appliesToBillingInterval in INTERVAL_LABEL_KEYS)
                    ? t("detailAnyInterval")
                    : t(
                        INTERVAL_LABEL_KEYS[
                          detailData.appliesToBillingInterval as keyof typeof INTERVAL_LABEL_KEYS
                        ]
                      )}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailFirstPurchaseOnly")}
                </span>
                <span>
                  {detailData.firstPurchaseOnly
                    ? t("detailYes")
                    : t("detailNo")}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">
                  {t("detailCreated")}
                </span>
                <span>{formatDate(locale, detailData.createdAt)}</span>
              </div>
            </div>

            <div>
              <h3 className="mb-3 font-semibold">{t("redemptionsTitle")}</h3>
              {redemptions.isLoading ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : !redemptionData || redemptionData.total === 0 ? (
                <EmptyState
                  icon={RiCouponLine}
                  title={t("noRedemptionsTitle")}
                  description={t("noRedemptionsDescription")}
                />
              ) : (
                <>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("redemptionsColDate")}</TableHead>
                          <TableHead>{t("redemptionsColCustomer")}</TableHead>
                          <TableHead>{t("redemptionsColAmount")}</TableHead>
                          <TableHead>
                            {t("redemptionsColSubscription")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {redemptionData.redemptions.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              {formatDate(locale, row.createdAt)}
                            </TableCell>
                            <TableCell>
                              {row.userId ? (
                                <Link
                                  href={`/admin/all-users/${row.userId}`}
                                  className="font-medium hover:underline"
                                >
                                  {row.userName ??
                                    row.userEmail ??
                                    t("unknownCustomer")}
                                </Link>
                              ) : (
                                <span className="font-medium">
                                  {row.userEmail ?? t("unknownCustomer")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {formatAmountMinor(
                                locale,
                                row.discountAmount,
                                row.currency,
                                t("amountUnknown")
                              )}
                            </TableCell>
                            <TableCell>
                              {row.subscriptionId ? (
                                <span className="font-mono text-xs">
                                  {row.subscriptionId}
                                </span>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {t("showing", {
                        from:
                          redemptionData.total === 0
                            ? 0
                            : (redemptionData.page - 1) *
                                redemptionData.perPage +
                              1,
                        to: Math.min(
                          redemptionData.total,
                          redemptionData.page * redemptionData.perPage
                        ),
                        total: redemptionData.total,
                      })}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={redemptionData.page <= 1}
                        onClick={() => setRedemptionPage(redemptionPage - 1)}
                      >
                        {t("previous")}
                      </Button>
                      <span className="self-center">
                        {t("pageOf", {
                          page: redemptionData.page,
                          totalPages: redemptionData.totalPages,
                        })}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          redemptionData.page >= redemptionData.totalPages
                        }
                        onClick={() => setRedemptionPage(redemptionPage + 1)}
                      >
                        {t("next")}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
