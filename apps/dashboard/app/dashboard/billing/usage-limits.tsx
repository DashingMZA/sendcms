"use client"

import { useMyUsage } from "@sendcms/billing/queries"
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

// BIL-124 (Wave 6): the customer's plan limits and remaining quota,
// per meter, from the same live counts enforcement uses. Renders
// nothing while loading or on error — the billing page must never
// break because the usage read failed.
export function UsageLimits() {
  const { t } = useTranslation("billing")
  const { data: usage, isLoading, isError } = useMyUsage()

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("usageTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }
  if (isError || !usage) return null

  const meters = [
    { key: "FORMS", label: t("meterForms") },
    { key: "DOMAINS", label: t("meterDomains") },
    { key: "SUBMISSIONS", label: t("meterSubmissions") },
    { key: "API_KEYS", label: t("meterApiKeys") },
    { key: "AI_REQUESTS", label: t("meterAiRequests") },
    { key: "MCP_REQUESTS", label: t("meterMcpRequests") },
  ] as const

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("usageTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {usage.denied ? (
          <p className="text-sm text-muted-foreground">{t("usageDenied")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {meters.map(({ key, label }) => {
              const check = usage.meters[key]
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-4"
                >
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-sm text-muted-foreground">
                    {check.limit === null
                      ? `${check.used} · ${t("unlimited")}`
                      : `${check.used} ${t("used")} / ${check.limit} · ${check.remaining ?? 0} ${t("remaining")}`}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
