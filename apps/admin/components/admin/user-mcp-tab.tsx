"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { UserMcpSettingsRow } from "@sendcms/mcp-admin"
import {
  useSetUserMcpSettings,
  useUserMcpSettings,
} from "@sendcms/mcp-admin/queries"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Switch,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

type Props = {
  userId: string
  actorRole: PlatformRole | AdminRole
  /** Null when the server could not read the settings (the actor
      lacks VIEW_MCP) — the tab then shows the no-permission card and
      never fires the settings query. */
  initialSettings: UserMcpSettingsRow | null
  /** The canonical 19-tool registry, imported from @sendcms/mcp by
      the server page and passed down — never a second copy. */
  toolNames: readonly string[]
}

/**
 * The user detail's MCP tab (Phase 6 — real, not planned): the
 * per-user enable switch, the tool allowlist, and the quota
 * overrides. Every save carries the reason the service requires.
 * The keys list below this card stays where Phase 3 put it, in
 * user-detail.tsx. The service enforces authorization server-side;
 * the UI only hides what the actor cannot do.
 */
export function UserMcpTab({
  userId,
  actorRole,
  initialSettings,
  toolNames,
}: Props) {
  const { t } = useTranslation("mcp")

  if (!initialSettings) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <UserMcpSettingsForm
      userId={userId}
      actorRole={actorRole}
      initialSettings={initialSettings}
      toolNames={toolNames}
    />
  )
}

/** Parse a quota input: "" = plan default (null), a positive integer
    = that limit, anything else = invalid (undefined). */
function parseLimit(value: string): number | null | undefined {
  if (value.trim() === "") return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function UserMcpSettingsForm({
  userId,
  actorRole,
  initialSettings,
  toolNames,
}: Omit<Props, "initialSettings"> & {
  initialSettings: UserMcpSettingsRow
}) {
  const { t } = useTranslation("mcp")
  const canManageMcp = adminCan(actorRole, "MANAGE_MCP")

  const { data } = useUserMcpSettings(userId)
  const setSettings = useSetUserMcpSettings(userId)

  const [isEnabled, setIsEnabled] = useState(initialSettings.isEnabled)
  const [allowAll, setAllowAll] = useState(
    initialSettings.allowedTools === null
  )
  const [allowedTools, setAllowedTools] = useState<string[]>(
    initialSettings.allowedTools ?? []
  )
  const [minuteLimit, setMinuteLimit] = useState(
    initialSettings.minuteLimit?.toString() ?? ""
  )
  const [hourLimit, setHourLimit] = useState(
    initialSettings.hourLimit?.toString() ?? ""
  )
  const [reason, setReason] = useState("")

  // Adjust state during render when the query data changes (e.g.
  // after a save refetches): the form always reflects the server.
  // This is the repo's rule-satisfying pattern for prop/query → state
  // sync — setState in an effect is rejected by the linter.
  const [lastSynced, setLastSynced] = useState(data ?? initialSettings)
  if (data && data !== lastSynced) {
    setLastSynced(data)
    setIsEnabled(data.isEnabled)
    setAllowAll(data.allowedTools === null)
    setAllowedTools(data.allowedTools ?? [])
    setMinuteLimit(data.minuteLimit?.toString() ?? "")
    setHourLimit(data.hourLimit?.toString() ?? "")
  }

  const minute = parseLimit(minuteLimit)
  const hour = parseLimit(hourLimit)
  const limitsValid = minute !== undefined && hour !== undefined
  const canSave =
    canManageMcp &&
    limitsValid &&
    reason.trim() !== "" &&
    !setSettings.isPending

  function toggleTool(tool: string, checked: boolean) {
    setAllowedTools((prev) =>
      checked ? [...prev, tool] : prev.filter((item) => item !== tool)
    )
  }

  async function onSave() {
    if (minute === undefined || hour === undefined) return
    try {
      await setSettings.mutateAsync({
        isEnabled,
        allowedTools: allowAll ? null : allowedTools,
        minuteLimit: minute,
        hourLimit: hour,
        reason: reason.trim(),
      })
      toast.success(t("settingsSaved"))
      setReason("")
    } catch {
      // The query provider's global mutation error toast already
      // shows the failure.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("userMcpTitle")}</CardTitle>
        <CardDescription>{t("userMcpDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {!canManageMcp && (
          <p className="text-sm text-muted-foreground">{t("readOnlyNote")}</p>
        )}

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
              disabled={!canManageMcp}
            />
            {t("enabledLabel")}
          </label>
          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("toolsTitle")}</h3>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allowAll}
              onCheckedChange={(checked) => {
                const next = checked === true
                setAllowAll(next)
                // Unchecking "allow all" starts from every tool
                // checked — the admin then removes the ones to block.
                // Without this the form would save an empty list,
                // which blocks every tool.
                if (!next) setAllowedTools([...toolNames])
              }}
              disabled={!canManageMcp}
            />
            {t("allowAllLabel")}
          </label>
          <p className="text-xs text-muted-foreground">{t("allowAllHint")}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {toolNames.map((tool) => (
              <label
                key={tool}
                className="flex items-center gap-1.5 font-mono text-sm"
              >
                <Checkbox
                  checked={allowAll || allowedTools.includes(tool)}
                  onCheckedChange={(checked) =>
                    toggleTool(tool, checked === true)
                  }
                  disabled={!canManageMcp || allowAll}
                />
                {tool}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("toolsDescription")}
          </p>
          {!allowAll && allowedTools.length === 0 && (
            <p className="text-sm font-medium">{t("toolsEmptyNote")}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="user-mcp-minute-limit">
              {t("minuteLimitLabel")}
            </Label>
            <Input
              id="user-mcp-minute-limit"
              type="number"
              min={1}
              value={minuteLimit}
              onChange={(e) => setMinuteLimit(e.target.value)}
              placeholder={t("limitPlanDefault")}
              disabled={!canManageMcp}
              className="w-40"
            />
            <p className="text-xs text-muted-foreground">
              {t("minuteLimitHint")}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-mcp-hour-limit">{t("hourLimitLabel")}</Label>
            <Input
              id="user-mcp-hour-limit"
              type="number"
              min={1}
              value={hourLimit}
              onChange={(e) => setHourLimit(e.target.value)}
              placeholder={t("limitPlanDefault")}
              disabled={!canManageMcp}
              className="w-40"
            />
            <p className="text-xs text-muted-foreground">
              {t("hourLimitHint")}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("limitZeroNote")}</p>
        {!limitsValid && (
          <p className="text-sm text-destructive">{t("limitInvalid")}</p>
        )}

        {canManageMcp && (
          <div className="space-y-1">
            <Label htmlFor="user-mcp-reason">{t("reasonLabel")}</Label>
            <Textarea
              id="user-mcp-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              maxLength={500}
              rows={3}
            />
            {reason.trim() === "" && (
              <p className="text-sm text-destructive">{t("reasonRequired")}</p>
            )}
          </div>
        )}

        {canManageMcp && (
          <div>
            <Button onClick={onSave} disabled={!canSave}>
              {t("saveSettings")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
