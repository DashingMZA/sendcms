// Plan version comparison (Wave 10, SRC-118 split of plan-detail.tsx):
// field-level before/after diff of two versions, plus the shared
// interval/status label helpers the shell's history table also uses.
"use client"

import { RiInformationLine } from "@remixicon/react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { usePlanCompare } from "@sendcms/plans/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatLimit, formatPrice } from "../plan-format"

export function intervalLabel(
  interval: string,
  t: (key: string) => string
): string {
  switch (interval) {
    case "MONTHLY":
      return t("intervalMonthly")
    case "ANNUAL":
      return t("intervalAnnual")
    case "CUSTOM":
      return t("intervalCustom")
    case "ONE_TIME":
      return t("intervalOneTime")
    default:
      return interval
  }
}

export function versionStatusLabel(
  status: string,
  t: (key: string) => string
): string {
  switch (status) {
    case "DRAFT":
      return t("versionStatusDraft")
    case "PUBLISHED":
      return t("versionStatusPublished")
    case "SUPERSEDED":
      return t("versionStatusSuperseded")
    case "ARCHIVED":
      return t("versionStatusArchived")
    default:
      return status
  }
}

/** Field-level before/after comparison of two versions. */
export function VersionCompare({
  fromId,
  toId,
}: {
  fromId: string | null
  toId: string | null
}) {
  const { t } = useTranslation("plans")
  const { t: tErrors } = useTranslation("errors")
  const locale = useLocale()
  const { data, isPending, isError } = usePlanCompare(fromId, toId)

  if (!fromId || !toId) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("compareSelectPrompt")}
      </p>
    )
  }
  if (isPending) {
    return <p className="text-sm text-muted-foreground">…</p>
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">{tErrors("generic")}</p>
  }
  if (data.changes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
        <RiInformationLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("compareNoChanges")}
        </h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("compareNoChangesDescription")}
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("compareField")}</TableHead>
            <TableHead>
              {t("compareFrom")}: {data.from.planName} v{data.from.version}
            </TableHead>
            <TableHead>
              {t("compareTo")}: {data.to.planName} v{data.to.version}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.changes.map((change) => (
            <TableRow key={change.field}>
              <TableCell className="font-medium">{change.label}</TableCell>
              <TableCell>
                {formatDiffValue(
                  locale,
                  change.field,
                  change.from,
                  data.from,
                  t
                )}
              </TableCell>
              <TableCell>
                {formatDiffValue(locale, change.field, change.to, data.to, t)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Render one diff value field-aware (null = unlimited / free). */
function formatDiffValue(
  locale: string,
  field: string,
  value: unknown,
  version: { priceCurrency: string },
  t: (key: string) => string
): string {
  const unlimited = t("limitUnlimited")
  if (field === "priceAmount") {
    return formatPrice(
      locale,
      value as number | null,
      version.priceCurrency,
      t("priceFree")
    )
  }
  if (
    field === "forms" ||
    field === "domains" ||
    field === "submissionsPerMonth" ||
    field === "aiRequestsPerDay" ||
    field === "mcpRequestsPerMinute" ||
    field === "mcpRequestsPerHour"
  ) {
    return formatLimit(locale, value as number | null, unlimited)
  }
  if (field === "billingInterval") {
    return intervalLabel(String(value), t)
  }
  if (field === "aiByokAllowed" || field === "aiPlatformAllowed") {
    return value === true ? t("yes") : t("no")
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—"
  }
  if (value === null || value === undefined) return "—"
  return String(value)
}
