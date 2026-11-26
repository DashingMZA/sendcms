// The typed entitlement config as a readable table (Wave 10, SRC-118
// split of plan-detail.tsx). Re-exported from plan-detail.tsx so
// existing import sites keep working.
"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import type { PlanEntitlements } from "@sendcms/plans/validators"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatLimit } from "../plan-format"

export function EntitlementsTable({
  entitlements,
}: {
  entitlements: PlanEntitlements
}) {
  const { t } = useTranslation("plans")
  const locale = useLocale()
  const unlimited = t("limitUnlimited")
  const rows: { label: string; value: string }[] = [
    {
      label: t("entForms"),
      value: formatLimit(locale, entitlements.forms, unlimited),
    },
    {
      label: t("entDomains"),
      value: formatLimit(locale, entitlements.domains, unlimited),
    },
    {
      label: t("entSubmissions"),
      value: formatLimit(locale, entitlements.submissionsPerMonth, unlimited),
    },
    { label: t("entApiKeys"), value: String(entitlements.apiKeys) },
    {
      label: t("entAiRequests"),
      value: formatLimit(locale, entitlements.aiRequestsPerDay, unlimited),
    },
    {
      label: t("entMcpMinute"),
      value: formatLimit(locale, entitlements.mcpRequestsPerMinute, unlimited),
    },
    {
      label: t("entMcpHour"),
      value: formatLimit(locale, entitlements.mcpRequestsPerHour, unlimited),
    },
    {
      label: t("entAiProviders"),
      value:
        entitlements.aiProviders.length > 0
          ? entitlements.aiProviders.join(", ")
          : "—",
    },
    {
      label: t("entByok"),
      value: entitlements.aiByokAllowed ? t("yes") : t("no"),
    },
    {
      label: t("entPlatformAi"),
      value: entitlements.aiPlatformAllowed ? t("yes") : t("no"),
    },
    {
      label: t("entFeatures"),
      value:
        entitlements.features.length > 0
          ? entitlements.features.join(", ")
          : "—",
    },
  ]
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("entitlementsTitle")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="text-muted-foreground">
                {row.label}
              </TableCell>
              <TableCell className="font-medium">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
