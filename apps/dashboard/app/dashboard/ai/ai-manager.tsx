"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  useAiBillingMode,
  useAiKeys,
  useDeleteAiKey,
  useMyAiUsage,
  useSaveAiKey,
  useSetAiBillingMode,
  useSetAiKeyEnabled,
  useTestAiKey,
  useTestBrowserAiKey,
} from "@sendcms/ai-settings/queries"
import type { AiKeyTestResult, UserAiKeyMeta } from "@sendcms/ai-settings"
import { AI_PROVIDER_NAMES } from "@sendcms/ai-settings/validators"
import type { AiProviderName } from "@sendcms/ai"
import type { AiBillingMode } from "@sendcms/database"
import { ApiClientError } from "@sendcms/shared"
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"
import {
  readBrowserKeyMeta,
  readBrowserKeyValue,
  removeBrowserKey,
  writeBrowserKey,
  type BrowserKeyMeta,
} from "./ai-browser-keys"
import { ProviderKeyCard } from "./ai-provider-key-card"
import { StoragePopup, type PendingStorageAction } from "./ai-storage-popup"

const ALL_MODES: AiBillingMode[] = ["BYOK", "PLATFORM", "DISABLED"]

const PROVIDER_DISPLAY_NAMES: Record<AiProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
}

/**
 * The customer's AI page (Phase 5 — BYOK): one key per provider, a
 * Test button with every saved key, and the billing-mode selector.
 * Saving or testing a key opens the storage popup: "Browser only"
 * (this browser, never the server) or "Both (browser + server)"
 * (encrypted in the database, works from any device). A saved key's
 * value is never displayed — only its fingerprint's last 4 chars.
 *
 * (Wave 10, SRC-118: browser-key storage lives in ai-browser-keys.ts,
 * the per-provider card in ai-provider-key-card.tsx, and the storage
 * popup in ai-storage-popup.tsx — this file is the shell.)
 */
export function AiManager({
  initialKeys,
  initialBillingMode,
}: {
  // AIM-013 / SRC-110: server-fetched by the AI page so the mode
  // selector and key cards render in the SSR HTML.
  initialKeys?: UserAiKeyMeta[]
  initialBillingMode?: AiBillingMode
}) {
  const { t } = useTranslation("ai")

  const {
    data: serverKeys,
    isLoading: keysLoading,
    isError: keysError,
  } = useAiKeys(initialKeys)
  const {
    data: billingMode,
    isLoading: modeLoading,
    isError: modeError,
  } = useAiBillingMode(initialBillingMode)
  const { data: myAiUsage, isLoading: aiUsageLoading } = useMyAiUsage()
  const saveKey = useSaveAiKey()
  const testKey = useTestAiKey()
  const testBrowserKey = useTestBrowserAiKey()
  const setEnabled = useSetAiKeyEnabled()
  const deleteKey = useDeleteAiKey()
  const setBillingMode = useSetAiBillingMode()

  const [browserKeys, setBrowserKeys] = useState<
    Partial<Record<AiProviderName, BrowserKeyMeta>>
  >({})
  const [pending, setPending] = useState<PendingStorageAction | null>(null)
  const [testResults, setTestResults] = useState<
    Partial<Record<AiProviderName, AiKeyTestResult>>
  >({})
  const [deleteTarget, setDeleteTarget] = useState<{
    provider: AiProviderName
    kind: "server" | "browser"
  } | null>(null)
  // DSH-301: a 503 from a server save is a platform-config problem,
  // not the user's fault — keep a persistent notice up (the toast
  // alone disappears) until a save succeeds.
  const [storageUnavailable, setStorageUnavailable] = useState(false)

  // Browser-only keys live in localStorage — read after mount (never
  // during render, or hydration would mismatch).
  useEffect(() => {
    const found: Partial<Record<AiProviderName, BrowserKeyMeta>> = {}
    for (const provider of AI_PROVIDER_NAMES) {
      const meta = readBrowserKeyMeta(provider)
      if (meta) found[provider] = meta
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists after mount; reading it during render would throw on the server and mismatch hydration.
    setBrowserKeys(found)
  }, [])

  function refreshBrowserKeys() {
    const found: Partial<Record<AiProviderName, BrowserKeyMeta>> = {}
    for (const provider of AI_PROVIDER_NAMES) {
      const meta = readBrowserKeyMeta(provider)
      if (meta) found[provider] = meta
    }
    setBrowserKeys(found)
  }

  async function onBillingModeChange(mode: AiBillingMode) {
    try {
      await setBillingMode.mutateAsync(mode)
      toast.success(t("billingModeChanged"))
    } catch (err) {
      toast.error(
        err instanceof ApiClientError
          ? err.message
          : t("billingModeChangeFailed")
      )
    }
  }

  /** The storage popup's "Both" choice: save encrypted on the server.
      AIM-025: the server enforces the provider-terms acknowledgement;
      the popup only enables "Both" once the user checks it, and the
      flag travels with the save. */
  async function saveToServer(
    action: PendingStorageAction,
    termsAcknowledged: boolean
  ) {
    try {
      await saveKey.mutateAsync({
        provider: action.provider,
        apiKey: action.apiKey,
        model: action.model.trim() || undefined,
        termsAcknowledged,
      })
      toast.success(t("keySaved"))
      setStorageUnavailable(false)
      setPending(null)
      if (action.action === "test") {
        await runServerTest(action.provider)
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 503) {
        setStorageUnavailable(true)
      }
      toast.error(
        err instanceof ApiClientError ? err.message : t("actionFailed")
      )
    }
  }

  /** The storage popup's "Browser only" choice: localStorage only. */
  function saveToBrowser(action: PendingStorageAction) {
    writeBrowserKey(action.provider, action.apiKey, action.model)
    refreshBrowserKeys()
    setPending(null)
    if (action.action === "test") {
      // A browser-only key is tested live too: the raw key is sent
      // for this one call and is never stored on the server.
      void runBrowserTest(action.provider, action.apiKey, action.model)
    }
  }

  async function runServerTest(provider: AiProviderName) {
    try {
      const result = await testKey.mutateAsync(provider)
      setTestResults((prev) => ({ ...prev, [provider]: result }))
      if (!result.ok) toast.error(result.error ?? t("testFailed"))
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : t("testFailed"))
    }
  }

  async function runBrowserTest(
    provider: AiProviderName,
    apiKey: string,
    model: string
  ) {
    try {
      const result = await testBrowserKey.mutateAsync({
        provider,
        apiKey,
        model: model.trim() || undefined,
      })
      setTestResults((prev) => ({ ...prev, [provider]: result }))
      if (!result.ok) toast.error(result.error ?? t("testFailed"))
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : t("testFailed"))
    }
  }

  async function onDeleteConfirm() {
    if (!deleteTarget) return
    if (deleteTarget.kind === "browser") {
      removeBrowserKey(deleteTarget.provider)
      refreshBrowserKeys()
      setDeleteTarget(null)
      toast.success(t("keyDeleted"))
      return
    }
    try {
      await deleteKey.mutateAsync(deleteTarget.provider)
      setDeleteTarget(null)
      toast.success(t("keyDeleted"))
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : t("actionFailed")
      )
    }
  }

  // AIM-018: no guessed mode. `billingMode` stays undefined until
  // the query resolves — the selector must show a skeleton while
  // loading and an error when the fetch fails, never PLATFORM as a
  // placeholder for an unknown mode.
  const mode = billingMode
  // AIM-014: warn when BYOK is selected but no key exists anywhere
  // (server or this browser) — AI calls will fail until one is saved.
  const hasAnyKey =
    (serverKeys ?? []).length > 0 || Object.keys(browserKeys).length > 0

  // Provider-reported costs only, in micro-units — never an estimate.
  function formatCost(costMicros: number): string {
    return `$${(costMicros / 1_000_000).toFixed(4)}`
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("billingModeTitle")}</CardTitle>
          <CardDescription>{t("billingModeDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {modeLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : modeError || !mode ? (
            <p role="alert" className="text-sm text-destructive">
              {t("billingModeLoadFailed")}
            </p>
          ) : (
            ALL_MODES.map((m) => {
              const selected = mode === m
              const labelKey =
                m === "BYOK"
                  ? "modeByok"
                  : m === "PLATFORM"
                    ? "modePlatform"
                    : "modeDisabled"
              const descKey =
                m === "BYOK"
                  ? "modeByokDescription"
                  : m === "PLATFORM"
                    ? "modePlatformDescription"
                    : "modeDisabledDescription"
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onBillingModeChange(m)}
                  disabled={setBillingMode.isPending}
                  className={`rounded-lg border p-4 text-start ${
                    selected ? "border-primary bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <span className="block text-sm font-semibold">
                    {t(labelKey)}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {t(descKey)}
                  </span>
                </button>
              )
            })
          )}
          {mode === "BYOK" && <Callout>{t("platformPausedNotice")}</Callout>}
        </CardContent>
      </Card>

      {/* AIM-014 (Wave 6): what the mode entitles the customer to —
          remaining AI allowance for today, today's BYOK/platform
          calls, and provider-reported cost. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("usageTitle")}</CardTitle>
          <CardDescription>{t("usageDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {aiUsageLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : myAiUsage ? (
            <>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("remainingToday")}</p>
                <p className="text-sm text-muted-foreground">
                  {myAiUsage.allowance.limit === null
                    ? t("allowanceUnlimited")
                    : (myAiUsage.allowance.remaining ?? 0)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("usedToday")}</p>
                <p className="text-sm text-muted-foreground">
                  {myAiUsage.allowance.used}
                  {myAiUsage.allowance.limit !== null &&
                    ` / ${myAiUsage.allowance.limit}`}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("byokCallsToday")}</p>
                <p className="text-sm text-muted-foreground">
                  {myAiUsage.today.byok.calls}
                  {myAiUsage.today.byok.failed > 0 &&
                    ` (${myAiUsage.today.byok.failed} ${t("callsFailed")})`}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("platformCallsToday")}</p>
                <p className="text-sm text-muted-foreground">
                  {myAiUsage.today.platform.calls}
                  {myAiUsage.today.platform.failed > 0 &&
                    ` (${myAiUsage.today.platform.failed} ${t("callsFailed")})`}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("costToday")}</p>
                <p className="text-sm text-muted-foreground">
                  {formatCost(myAiUsage.today.total.costMicros)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">{t("totalCost")}</p>
                <p className="text-sm text-muted-foreground">
                  {formatCost(myAiUsage.totalCostMicros)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">{t("costNote")}</p>
              {mode === "BYOK" && !hasAnyKey && (
                <Callout>{t("byokNoKeyWarning")}</Callout>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      {storageUnavailable && (
        <Callout variant="destructive" role="alert">
          {t("storageUnavailableNotice")}
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("keysTitle")}</CardTitle>
          <CardDescription>{t("keysDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {keysLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : keysError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("keysLoadFailed")}
            </p>
          ) : (
            AI_PROVIDER_NAMES.map((provider) => {
              const serverKey = (serverKeys ?? []).find(
                (k) => k.provider === provider
              )
              const browserKey = browserKeys[provider] ?? null
              return (
                <ProviderKeyCard
                  key={provider}
                  provider={provider}
                  displayName={PROVIDER_DISPLAY_NAMES[provider]}
                  serverKey={serverKey ?? null}
                  browserKey={browserKey}
                  testResult={testResults[provider] ?? null}
                  onSaveOrTest={(apiKey, model, action) =>
                    setPending({ provider, apiKey, model, action })
                  }
                  onTestServer={() => runServerTest(provider)}
                  onToggleEnabled={async (enabled) => {
                    try {
                      await setEnabled.mutateAsync({ provider, enabled })
                      toast.success(
                        enabled ? t("keyEnabled") : t("keyDisabled")
                      )
                    } catch (err) {
                      toast.error(
                        err instanceof ApiClientError
                          ? err.message
                          : t("actionFailed")
                      )
                    }
                  }}
                  onDeleteServer={() =>
                    setDeleteTarget({ provider, kind: "server" })
                  }
                  onDeleteBrowser={() =>
                    setDeleteTarget({ provider, kind: "browser" })
                  }
                  onTestBrowser={() => {
                    const value = readBrowserKeyValue(provider)
                    if (!value) return
                    setPending({
                      provider,
                      apiKey: value,
                      model: browserKey?.model ?? "",
                      action: "test",
                    })
                  }}
                />
              )
            })
          )}
        </CardContent>
      </Card>

      <StoragePopup
        pending={pending}
        displayName={pending ? PROVIDER_DISPLAY_NAMES[pending.provider] : ""}
        onClose={() => setPending(null)}
        onBrowserOnly={saveToBrowser}
        onBoth={saveToServer}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={onDeleteConfirm}>
              {t("confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
