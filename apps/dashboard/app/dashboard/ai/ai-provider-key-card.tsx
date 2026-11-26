"use client"

import { useState } from "react"
import type { AiKeyTestResult, UserAiKeyMeta } from "@sendcms/ai-settings"
import type { AiProviderName } from "@sendcms/ai"
import { Badge, Button, Card, CardContent, Input, Label } from "@sendcms/ui"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"
import type { BrowserKeyMeta } from "./ai-browser-keys"

// One provider's key card (Wave 10, SRC-118: split out of
// ai-manager.tsx by concern). A provider can hold a server key, a
// browser-only key, both, or neither; each kind has its own
// test/delete path, and saving or testing opens the storage popup in
// the shell.
export function ProviderKeyCard({
  provider,
  displayName,
  serverKey,
  browserKey,
  testResult,
  onSaveOrTest,
  onTestServer,
  onToggleEnabled,
  onDeleteServer,
  onDeleteBrowser,
  onTestBrowser,
}: {
  provider: AiProviderName
  displayName: string
  serverKey: UserAiKeyMeta | null
  browserKey: BrowserKeyMeta | null
  testResult: AiKeyTestResult | null
  onSaveOrTest: (apiKey: string, model: string, action: "save" | "test") => void
  onTestServer: () => void
  onToggleEnabled: (enabled: boolean) => void
  onDeleteServer: () => void
  onDeleteBrowser: () => void
  onTestBrowser: () => void
}) {
  const { t } = useTranslation("ai")
  const locale = useLocale()
  const [showForm, setShowForm] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState(serverKey?.model ?? "")

  const valid = apiKey.trim().length >= 8

  function submit(action: "save" | "test") {
    if (!valid) return
    onSaveOrTest(apiKey.trim(), model.trim(), action)
    setApiKey("")
    setShowForm(false)
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{displayName}</h3>
          <div className="flex gap-2">
            {serverKey && (
              <Badge variant="secondary">{t("savedOnServer")}</Badge>
            )}
            {browserKey && (
              <Badge variant="secondary">{t("savedInBrowser")}</Badge>
            )}
            {!serverKey && !browserKey && (
              <Badge variant="secondary">{t("notSaved")}</Badge>
            )}
          </div>
        </div>

        {serverKey && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              {t("modelLabel")}: {serverKey.model ?? t("modelPlaceholder")} ·{" "}
              {t("keyFingerprint")}: …{serverKey.fingerprintLast4}
            </p>
            <p className="text-muted-foreground">
              {t("lastTested")}:{" "}
              {serverKey.lastTestedAt
                ? formatDate(locale, serverKey.lastTestedAt, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : t("neverTested")}{" "}
              ·{" "}
              {serverKey.lastTestStatus === "OK"
                ? t("testOk")
                : serverKey.lastTestStatus === "FAILED"
                  ? t("testFailed")
                  : t("neverTested")}
            </p>
            {/* AIM-003: a key the server auto-disabled after repeated
                provider rejections says so plainly, with the fix — the
                user re-enables it after checking the key. */}
            {!serverKey.isEnabled && serverKey.authFailureCount >= 3 && (
              <p role="alert" className="text-sm text-destructive">
                {t("keyAutoDisabled")}
              </p>
            )}
            {testResult && (
              <p
                className={
                  testResult.ok
                    ? "text-sm font-medium"
                    : "text-sm font-medium text-destructive"
                }
              >
                {testResult.ok
                  ? `${t("testOk")} — ${testResult.model} (${testResult.latencyMs} ms)`
                  : `${t("testFailed")}: ${testResult.error ?? ""}`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onTestServer}>
                {t("testKey")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onToggleEnabled(!serverKey.isEnabled)}
              >
                {serverKey.isEnabled ? t("disableKey") : t("enableKey")}
              </Button>
              <Button size="sm" variant="outline" onClick={onDeleteServer}>
                {t("deleteKey")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setModel(serverKey.model ?? "")
                  setShowForm(true)
                }}
              >
                {t("replaceKey")}
              </Button>
            </div>
          </div>
        )}

        {browserKey && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              {t("browserOnlyBadge")} · {t("modelLabel")}:{" "}
              {browserKey.model ?? t("modelPlaceholder")}
            </p>
            {testResult && (
              <p
                className={
                  testResult.ok
                    ? "text-sm font-medium"
                    : "text-sm font-medium text-destructive"
                }
              >
                {testResult.ok
                  ? `${t("testOk")} — ${testResult.model} (${testResult.latencyMs} ms)`
                  : `${t("testFailed")}: ${testResult.error ?? ""}`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onTestBrowser}>
                {t("testKey")}
              </Button>
              <Button size="sm" variant="outline" onClick={onDeleteBrowser}>
                {t("deleteKey")}
              </Button>
            </div>
          </div>
        )}

        {showForm || (!serverKey && !browserKey) ? (
          <div className="flex flex-col gap-3 border-t pt-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`ai-key-${provider}`}>{t("saveKey")}</Label>
              <Input
                id={`ai-key-${provider}`}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t("keyPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`ai-model-${provider}`}>{t("modelLabel")}</Label>
              <Input
                id={`ai-model-${provider}`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t("modelPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("modelHint")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!valid} onClick={() => submit("save")}>
                {t("saveKey")}
              </Button>
              <Button
                variant="outline"
                disabled={!valid}
                onClick={() => submit("test")}
              >
                {t("testKey")}
              </Button>
              {showForm && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowForm(false)
                    setApiKey("")
                  }}
                >
                  {t("cancel")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setModel(serverKey?.model ?? browserKey?.model ?? "")
                setShowForm(true)
              }}
            >
              {t("replaceKey")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
