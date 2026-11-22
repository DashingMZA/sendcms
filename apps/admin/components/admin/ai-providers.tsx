"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useProviderConfigs,
  useProviderHealth,
  useSetProviderConfig,
} from "@sendcms/ai-settings/queries"
import type { AiProviderConfigRow } from "@sendcms/ai-settings"
import { ApiClientError } from "@sendcms/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Switch,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { providerDisplayName } from "./ai-format"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/**
 * The AI providers page (Phase 5): all five providers with their
 * admin config — enabled toggle, allowed models, default model — and
 * whether the platform key is configured (read-only; the key itself
 * lives in .env and is never shown). Saving calls setProviderConfig.
 */
export function AiProviders({ actorRole }: Props) {
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

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {t("platformControlsDescription")}
      </p>
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        (configs ?? []).map((config) => (
          <ProviderCard key={config.provider} config={config} />
        ))
      )}
    </div>
  )
}

function ProviderCard({ config }: { config: AiProviderConfigRow }) {
  const { t } = useTranslation("ai")
  const { data: health } = useProviderHealth()
  const setConfig = useSetProviderConfig()

  const [isEnabled, setIsEnabled] = useState(config.isEnabled)
  const [defaultModel, setDefaultModel] = useState(config.defaultModel ?? "")
  const [allowedModels, setAllowedModels] = useState(
    config.allowedModels.join("\n")
  )

  const healthRow = (health ?? []).find((h) => h.provider === config.provider)
  const dirty =
    isEnabled !== config.isEnabled ||
    defaultModel.trim() !== (config.defaultModel ?? "") ||
    allowedModels !== config.allowedModels.join("\n")

  async function onSave() {
    try {
      const models = allowedModels
        .split("\n")
        .map((m) => m.trim())
        .filter(Boolean)
      await setConfig.mutateAsync({
        provider: config.provider,
        input: {
          isEnabled,
          allowedModels: models,
          defaultModel: defaultModel.trim() || null,
        },
      })
      toast.success(t("providerSaved"))
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : t("providerSaveFailed")
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {providerDisplayName(config.provider)}
          <Badge variant="secondary">
            {healthRow?.platformKeyConfigured
              ? t("keyConfigured")
              : t("keyNotConfigured")}
          </Badge>
        </CardTitle>
        <CardDescription>{t("providersDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Switch
            id={`provider-enabled-${config.provider}`}
            checked={isEnabled}
            onCheckedChange={setIsEnabled}
          />
          <Label htmlFor={`provider-enabled-${config.provider}`}>
            {isEnabled ? t("enabled") : t("disabled")}
          </Label>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`provider-default-model-${config.provider}`}>
            {t("defaultModelLabel")}
          </Label>
          <Input
            id={`provider-default-model-${config.provider}`}
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={t("defaultModelPlaceholder")}
          />
          <p className="text-xs text-muted-foreground">
            {t("defaultModelHint")}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`provider-allowed-models-${config.provider}`}>
            {t("allowedModelsLabel")}
          </Label>
          <Textarea
            id={`provider-allowed-models-${config.provider}`}
            value={allowedModels}
            onChange={(e) => setAllowedModels(e.target.value)}
            placeholder={t("allowedModelsPlaceholder")}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            {t("allowedModelsHint")}
          </p>
        </div>
        <div>
          <Button onClick={onSave} disabled={!dirty || setConfig.isPending}>
            {t("saveProvider")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
