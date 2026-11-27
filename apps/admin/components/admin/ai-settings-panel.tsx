"use client"

import Link from "next/link"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useProviderConfigs } from "@sendcms/ai-settings/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { providerDisplayName } from "./ai-format"

type Props = {
  actorRole: PlatformRole | AdminRole
  emergency: boolean
}

/**
 * The AI settings page (Phase 5): the platform emergency switch
 * (display only — it lives in config/config.json and changing it
 * needs a server restart), the global provider availability summary,
 * and the per-plan AI controls (a link to the plans, where the
 * entitlements live). The emergency switch never disables form
 * submission, the inbox, or any non-AI service — said plainly here.
 */
export function AiSettingsPanel({ actorRole, emergency }: Props) {
  const { t } = useTranslation("ai")
  const canManageAi = adminCan(actorRole, "MANAGE_AI")
  const { data: configs, isLoading } = useProviderConfigs()

  if (!canManageAi) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  const enabledCount = (configs ?? []).filter((c) => c.isEnabled).length
  const totalCount = configs?.length ?? 0

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            {t("emergencyTitle")}
            <Badge variant={emergency ? "destructive" : "secondary"}>
              {emergency ? t("emergencyOn") : t("emergencyOff")}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t("emergencyNote")}</p>
          <p className="text-sm font-medium">{t("emergencyNeverDisables")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("platformControlsTitle")}</CardTitle>
          <CardDescription>{t("platformControlsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <p className="text-sm">
              {enabledCount} / {totalCount} {t("enabled")} —{" "}
              {(configs ?? [])
                .filter((c) => c.isEnabled)
                .map((c) => providerDisplayName(c.provider))
                .join(", ") || t("disabled")}
            </p>
          )}
          <div>
            <Button variant="outline" asChild>
              <Link href="/admin/ai/providers">{t("editProviders")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("planControlsTitle")}</CardTitle>
          <CardDescription>{t("planControlsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href="/admin/plans">{t("viewPlans")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
