"use client"

import { useSystemSummary } from "@sendcms/platform-ops/queries"
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

/** The required environment variables the summary reports presence
    for (booleans only — never values), with their display names. */
const ENV_VARS = [
  { key: "databaseUrl", name: "DATABASE_URL" },
  { key: "betterAuthSecret", name: "BETTER_AUTH_SECRET" },
  { key: "resendApiKey", name: "RESEND_API_KEY" },
  { key: "cronSecret", name: "CRON_SECRET" },
  { key: "aiByokMasterKey", name: "AI_BYOK_MASTER_KEY" },
] as const

/**
 * The system summary page (Phase 7, replacing the Phase 2 planned
 * empty state at /admin/settings): the runtime versions, the
 * required-environment presence booleans — never values — and the
 * config.json contents including the emergency flag, which lives in
 * config.json and needs a server restart to change.
 */
export function SystemOverview() {
  const { t } = useTranslation("settings")
  const { data, isLoading } = useSystemSummary()

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("versionsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("nodeVersion")}</dt>
              <dd className="font-mono">{data.nodeVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("prismaVersion")}</dt>
              <dd className="font-mono">{data.prismaClientVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("postgresVersion")}</dt>
              <dd className="font-mono">{data.postgresVersion}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("envTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{t("envNote")}</p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {ENV_VARS.map(({ key, name }) => (
              <div
                key={key}
                className="flex items-center justify-between gap-4"
              >
                <dt className="font-mono">{name}</dt>
                <dd>
                  <Badge variant={data.env[key] ? "secondary" : "destructive"}>
                    {data.env[key] ? t("set") : t("missing")}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("configTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("emergencyFlag")}:{" "}
            </span>
            <Badge variant={data.emergency ? "destructive" : "secondary"}>
              {data.emergency ? t("on") : t("off")}
            </Badge>
          </p>
          <p className="text-sm text-muted-foreground">{t("emergencyNote")}</p>
          <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs">
            {JSON.stringify(
              { platform: { emergency: data.emergency } },
              null,
              2
            )}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
