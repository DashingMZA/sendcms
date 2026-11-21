"use client"

import { useState } from "react"
import type { PlanEntitlements } from "@sendcms/plans/validators"
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

/**
 * The price + entitlements half of a plan / plan-version form. Used by
 * the create-plan dialog and the new-version dialog — both need exactly
 * the same fields, and both submit the same shape (a plan version is
 * just a price + entitlements snapshot). The parent dialog adds its
 * own fields (name/slug for create, change reason for both) around it.
 *
 * Prices are edited in major units (e.g. 19.99) and converted to minor
 * units (cents) on submit; an empty price means a free version.
 */

export type PlanVersionFormValues = {
  priceAmount: number | null
  priceCurrency: string
  billingInterval: "MONTHLY" | "ANNUAL" | "CUSTOM" | "ONE_TIME"
  trialDays: number
  entitlements: PlanEntitlements
}

type NullableLimitKey =
  | "forms"
  | "domains"
  | "submissionsPerMonth"
  | "aiRequestsPerDay"
  | "mcpRequestsPerMinute"
  | "mcpRequestsPerHour"

const NULLABLE_LIMITS: {
  key: NullableLimitKey
  labelKey: string
  hintKey?: string
}[] = [
  { key: "forms", labelKey: "entForms" },
  { key: "domains", labelKey: "entDomains" },
  { key: "submissionsPerMonth", labelKey: "entSubmissions" },
  { key: "aiRequestsPerDay", labelKey: "entAiRequests" },
  {
    key: "mcpRequestsPerMinute",
    labelKey: "entMcpMinute",
    hintKey: "mcpPerMinuteUnlimitedHint",
  },
  {
    key: "mcpRequestsPerHour",
    labelKey: "entMcpHour",
    hintKey: "mcpPerHourUnlimitedHint",
  },
]

const AI_PROVIDER_OPTIONS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const

type LimitState = {
  value: string
  unlimited: boolean
}

function limitState(value: number | null): LimitState {
  return value === null
    ? { value: "", unlimited: true }
    : { value: String(value), unlimited: false }
}

type Props = {
  initial: PlanVersionFormValues
  onSubmit: (values: PlanVersionFormValues) => void
  onCancel: () => void
  submitLabel: string
  pending?: boolean
}

export function PlanVersionForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  pending,
}: Props) {
  const { t } = useTranslation("plans")
  const [price, setPrice] = useState(
    initial.priceAmount === null ? "" : (initial.priceAmount / 100).toFixed(2)
  )
  const [currency, setCurrency] = useState(initial.priceCurrency)
  const [interval, setInterval] = useState(initial.billingInterval)
  const [trialDays, setTrialDays] = useState(String(initial.trialDays))
  const [limits, setLimits] = useState<Record<NullableLimitKey, LimitState>>({
    forms: limitState(initial.entitlements.forms),
    domains: limitState(initial.entitlements.domains),
    submissionsPerMonth: limitState(initial.entitlements.submissionsPerMonth),
    aiRequestsPerDay: limitState(initial.entitlements.aiRequestsPerDay),
    mcpRequestsPerMinute: limitState(initial.entitlements.mcpRequestsPerMinute),
    mcpRequestsPerHour: limitState(initial.entitlements.mcpRequestsPerHour),
  })
  const [apiKeys, setApiKeys] = useState(String(initial.entitlements.apiKeys))
  const [providers, setProviders] = useState<string[]>(
    initial.entitlements.aiProviders
  )
  const [byok, setByok] = useState(initial.entitlements.aiByokAllowed)
  const [platformAi, setPlatformAi] = useState(
    initial.entitlements.aiPlatformAllowed
  )
  const [features, setFeatures] = useState(
    initial.entitlements.features.join("\n")
  )
  const [error, setError] = useState<string | null>(null)

  function setLimit(key: NullableLimitKey, next: Partial<LimitState>) {
    setLimits((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const parsedPrice =
      price.trim() === "" ? null : Math.round(Number(price) * 100)
    if (
      parsedPrice !== null &&
      (!Number.isFinite(parsedPrice) || parsedPrice < 0)
    ) {
      setError(t("priceHint"))
      return
    }
    const parsedTrial = Number(trialDays)
    if (
      !Number.isInteger(parsedTrial) ||
      parsedTrial < 0 ||
      parsedTrial > 365
    ) {
      setError(t("trialDaysHint"))
      return
    }
    const parsedApiKeys = Number(apiKeys)
    if (!Number.isInteger(parsedApiKeys) || parsedApiKeys < 0) {
      setError(t("entApiKeys"))
      return
    }
    const entitlements: PlanEntitlements = {
      forms: null,
      domains: null,
      submissionsPerMonth: null,
      apiKeys: parsedApiKeys,
      aiRequestsPerDay: null,
      mcpRequestsPerMinute: null,
      mcpRequestsPerHour: null,
      aiProviders: providers as PlanEntitlements["aiProviders"],
      aiByokAllowed: byok,
      aiPlatformAllowed: platformAi,
      features: features
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    }
    for (const { key, labelKey } of NULLABLE_LIMITS) {
      const state = limits[key]
      if (state.unlimited) {
        entitlements[key] = null
      } else {
        const value = Number(state.value)
        if (!Number.isInteger(value) || value < 0) {
          setError(t(labelKey))
          return
        }
        entitlements[key] = value
      }
    }

    onSubmit({
      priceAmount: parsedPrice,
      priceCurrency: currency.trim().toUpperCase() || "USD",
      billingInterval: interval,
      trialDays: parsedTrial,
      entitlements,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="plan-version-price">{t("priceLabel")}</Label>
          <Input
            id="plan-version-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={t("pricePlaceholder")}
          />
          <p className="text-xs text-muted-foreground">{t("priceHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="plan-version-currency">{t("currencyLabel")}</Label>
          <Input
            id="plan-version-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="plan-version-interval">{t("intervalLabel")}</Label>
          <Select
            value={interval}
            onValueChange={(value) =>
              setInterval(value as PlanVersionFormValues["billingInterval"])
            }
          >
            <SelectTrigger id="plan-version-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MONTHLY">{t("intervalMonthly")}</SelectItem>
              <SelectItem value="ANNUAL">{t("intervalAnnual")}</SelectItem>
              <SelectItem value="CUSTOM">{t("intervalCustom")}</SelectItem>
              <SelectItem value="ONE_TIME">{t("intervalOneTime")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="plan-version-trial">{t("trialDaysLabel")}</Label>
          <Input
            id="plan-version-trial"
            type="number"
            min={0}
            max={365}
            value={trialDays}
            onChange={(e) => setTrialDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("trialDaysHint")}</p>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t("entitlementsTitle")}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {NULLABLE_LIMITS.map(({ key, labelKey, hintKey }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`plan-limit-${key}`}>{t(labelKey)}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`plan-limit-${key}`}
                  type="number"
                  min={0}
                  value={limits[key].value}
                  disabled={limits[key].unlimited}
                  onChange={(e) => setLimit(key, { value: e.target.value })}
                  className="w-28"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={limits[key].unlimited}
                    onCheckedChange={(checked) =>
                      setLimit(key, { unlimited: checked === true })
                    }
                  />
                  {t("unlimitedLabel")}
                </label>
              </div>
              {hintKey && (
                <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
              )}
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="plan-limit-apiKeys">{t("entApiKeys")}</Label>
            <Input
              id="plan-limit-apiKeys"
              type="number"
              min={0}
              value={apiKeys}
              onChange={(e) => setApiKeys(e.target.value)}
              className="w-28"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label>{t("entAiProviders")}</Label>
          <div className="flex flex-wrap gap-4">
            {AI_PROVIDER_OPTIONS.map((provider) => (
              <label
                key={provider}
                className="flex items-center gap-1.5 text-sm capitalize"
              >
                <Checkbox
                  checked={providers.includes(provider)}
                  onCheckedChange={(checked) =>
                    setProviders((prev) =>
                      checked === true
                        ? [...prev, provider]
                        : prev.filter((p) => p !== provider)
                    )
                  }
                />
                {provider}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={byok} onCheckedChange={setByok} />
            {t("entByok")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={platformAi} onCheckedChange={setPlatformAi} />
            {t("entPlatformAi")}
          </label>
        </div>

        <div className="space-y-1">
          <Label htmlFor="plan-features">{t("entFeatures")}</Label>
          <Textarea
            id="plan-features"
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder={t("featuresPlaceholder")}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{t("featuresHint")}</p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
