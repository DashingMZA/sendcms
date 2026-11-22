"use client"

import Link from "next/link"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useAiUsage, useProviderConfigs } from "@sendcms/ai-settings/queries"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { providerDisplayName } from "./ai-format"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/** ISO date (YYYY-MM-DD) of 30 days ago (UTC). */
function thirtyDaysAgoIso(): string {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/**
 * The AI models page (Phase 5): per provider, the configured default
 * model + allowed models, and which models were actually used in the
 * last 30 days (derived from the usage list — the most recent 100
 * records, said plainly on the page). Editing lives on the providers
 * page; this page is read-only.
 */
export function AiModels({ actorRole }: Props) {
  const { t } = useTranslation("ai")
  const canViewUsage = adminCan(actorRole, "VIEW_AI_USAGE")
  const { data: configs, isLoading: configsLoading } = useProviderConfigs()
  const { data: usage, isLoading: usageLoading } = useAiUsage({
    from: thirtyDaysAgoIso(),
    perPage: 100,
  })

  if (!canViewUsage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  // Calls per model in the sampled window (provider + model).
  const callsByModel = new Map<string, { provider: string; calls: number }>()
  for (const row of usage?.usage ?? []) {
    const key = `${row.provider}:${row.model}`
    const entry = callsByModel.get(key) ?? { provider: row.provider, calls: 0 }
    entry.calls += 1
    callsByModel.set(key, entry)
  }
  const modelsInUse = [...callsByModel.entries()]
    .map(([key, entry]) => ({
      model: key.slice(entry.provider.length + 1),
      provider: entry.provider,
      calls: entry.calls,
    }))
    .sort((a, b) => b.calls - a.calls)

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("providersTitle")}</CardTitle>
          <CardDescription>{t("providersDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {configsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colProvider")}</TableHead>
                    <TableHead>{t("defaultModelLabel")}</TableHead>
                    <TableHead>{t("allowedModelsLabel")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(configs ?? []).map((config) => (
                    <TableRow key={config.provider}>
                      <TableCell className="font-medium">
                        {providerDisplayName(config.provider)}
                      </TableCell>
                      <TableCell>
                        {config.defaultModel ?? t("defaultModelPlaceholder")}
                      </TableCell>
                      <TableCell>
                        {config.allowedModels.length === 0
                          ? t("defaultModelPlaceholder")
                          : config.allowedModels.join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="mt-4">
            <Button variant="outline" asChild>
              <Link href="/admin/ai/providers">{t("editProviders")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("modelsInUseTitle")}</CardTitle>
          <CardDescription>{t("modelsInUseDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {usageLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : modelsInUse.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noModelsUsed")}</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colModel")}</TableHead>
                    <TableHead>{t("colProvider")}</TableHead>
                    <TableHead>{t("colCalls")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelsInUse.map((row) => (
                    <TableRow key={`${row.provider}:${row.model}`}>
                      <TableCell className="font-medium">{row.model}</TableCell>
                      <TableCell>{providerDisplayName(row.provider)}</TableCell>
                      <TableCell>{row.calls}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("modelsInUseNote")}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
