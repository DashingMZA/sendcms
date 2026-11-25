"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useAiUsageSummary,
  useSetUserAiBillingMode,
  useUserAiKeys,
} from "@sendcms/ai-settings/queries"
import type { AiBillingMode } from "@sendcms/database"
import { ApiClientError } from "@sendcms/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatCostMicros, providerDisplayName } from "./ai-format"
import { formatDateTime } from "./plan-format"

const ALL_MODES: AiBillingMode[] = ["BYOK", "PLATFORM", "DISABLED"]

type Props = {
  userId: string
  userName: string | null
  userEmail: string
  actorRole: PlatformRole | AdminRole
  initialBillingMode: AiBillingMode
}

/**
 * The user detail's AI tab (Phase 5 — real, not planned): the user's
 * billing mode (view + admin set), their saved BYOK keys as METADATA
 * ONLY (provider, model, enabled, last tested, fingerprint last 4 —
 * never any key material), and their AI usage summary (BYOK vs
 * platform). The service enforces authorization server-side; the UI
 * only hides what the actor cannot do.
 */
export function UserAiTab({
  userId,
  userName,
  userEmail,
  actorRole,
  initialBillingMode,
}: Props) {
  const { t } = useTranslation("ai")
  const locale = useLocale()
  const canManageAi = adminCan(actorRole, "MANAGE_AI")

  const [billingMode, setBillingMode] =
    useState<AiBillingMode>(initialBillingMode)
  const setMode = useSetUserAiBillingMode(userId)
  const { data: keys, isLoading: keysLoading } = useUserAiKeys(userId)
  const { data: summary } = useAiUsageSummary({ userId })

  async function onBillingModeChange(mode: AiBillingMode) {
    const previous = billingMode
    setBillingMode(mode)
    try {
      await setMode.mutateAsync(mode)
      toast.success(t("billingModeChanged"))
    } catch (err) {
      setBillingMode(previous)
      toast.error(
        err instanceof ApiClientError
          ? err.message
          : t("billingModeChangeFailed")
      )
    }
  }

  const modeDescriptionKey =
    billingMode === "BYOK"
      ? "modeByokDescription"
      : billingMode === "PLATFORM"
        ? "modePlatformDescription"
        : "modeDisabledDescription"

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{userName ?? userEmail}</CardTitle>
          <CardDescription>{t("userAiDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="user-ai-billing-mode">
              {t("billingModeLabel")}
            </Label>
            {canManageAi ? (
              <Select
                value={billingMode}
                onValueChange={(v) => onBillingModeChange(v as AiBillingMode)}
              >
                <SelectTrigger id="user-ai-billing-mode" className="h-9 w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(
                        mode === "BYOK"
                          ? "modeByok"
                          : mode === "PLATFORM"
                            ? "modePlatform"
                            : "modeDisabled"
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm font-medium">{billingMode}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t(modeDescriptionKey)}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("keysTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {keysLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !keys || keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noKeys")}</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colProvider")}</TableHead>
                    <TableHead>{t("colModel")}</TableHead>
                    <TableHead>{t("colEnabled")}</TableHead>
                    <TableHead>{t("colLastTested")}</TableHead>
                    <TableHead>{t("colTestStatus")}</TableHead>
                    <TableHead>{t("colFingerprint")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">
                        {providerDisplayName(key.provider)}
                      </TableCell>
                      <TableCell>{key.model ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {key.isEnabled ? t("enabled") : t("disabled")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {key.lastTestedAt
                          ? formatDateTime(locale, key.lastTestedAt)
                          : t("neverTested")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {key.lastTestStatus === "OK"
                            ? t("testOk")
                            : key.lastTestStatus === "FAILED"
                              ? t("testFailed")
                              : t("testUntested")}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        …{key.fingerprintLast4}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("usageSummaryTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">{t("byokCalls")}</p>
              <p className="text-2xl font-bold tracking-tight">
                {summary?.byok.calls ?? 0}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("costReported")}:{" "}
                {summary
                  ? (formatCostMicros(locale, summary.byok.costMicros) ?? "—")
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t("platformCalls")}
              </p>
              <p className="text-2xl font-bold tracking-tight">
                {summary?.platform.calls ?? 0}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("costReported")}:{" "}
                {summary
                  ? (formatCostMicros(locale, summary.platform.costMicros) ??
                    "—")
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("totalCalls")}</p>
              <p className="text-2xl font-bold tracking-tight">
                {summary?.total.calls ?? 0}
              </p>
            </div>
          </div>
          <div>
            <Button variant="outline" asChild>
              <Link href={`/admin/ai/usage?userId=${userId}`}>
                {t("viewFullUsage")}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
