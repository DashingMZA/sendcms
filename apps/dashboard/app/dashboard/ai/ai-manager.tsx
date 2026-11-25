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
  Badge,
  Button,
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
  Input,
  Label,
  Skeleton,
} from "@sendcms/ui"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

// ─── Browser-only keys (localStorage) ──────────────────────────────────
// A browser-only key lives ONLY in this browser: localStorage under
// one key per provider. It is sent per request for capability calls
// (browserKey) and never reaches the server for storage, so
// background jobs (spam re-scoring, digests) cannot use it. The
// plaintext is read from localStorage only inside an event handler,
// never kept in React state, and never displayed.
const BROWSER_KEY_PREFIX = "sendcms:ai:browser-key:"

type BrowserKeyMeta = { model: string | null; savedAt: string }

function browserKeyStorageKey(provider: AiProviderName): string {
  return `${BROWSER_KEY_PREFIX}${provider}`
}

function readBrowserKeyMeta(provider: AiProviderName): BrowserKeyMeta | null {
  try {
    const raw = localStorage.getItem(browserKeyStorageKey(provider))
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      apiKey?: unknown
      model?: unknown
      savedAt?: unknown
    }
    if (typeof parsed.apiKey !== "string") return null
    return {
      model: typeof parsed.model === "string" ? parsed.model : null,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    }
  } catch {
    return null
  }
}

function readBrowserKeyValue(provider: AiProviderName): string | null {
  try {
    const raw = localStorage.getItem(browserKeyStorageKey(provider))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { apiKey?: unknown }
    return typeof parsed.apiKey === "string" ? parsed.apiKey : null
  } catch {
    return null
  }
}

function writeBrowserKey(
  provider: AiProviderName,
  apiKey: string,
  model: string
): void {
  localStorage.setItem(
    browserKeyStorageKey(provider),
    JSON.stringify({
      apiKey,
      model: model.trim() || null,
      savedAt: new Date().toISOString(),
    })
  )
}

function removeBrowserKey(provider: AiProviderName): void {
  localStorage.removeItem(browserKeyStorageKey(provider))
}

const ALL_MODES: AiBillingMode[] = ["BYOK", "PLATFORM", "DISABLED"]

const PROVIDER_DISPLAY_NAMES: Record<AiProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
}

type PendingStorageAction = {
  provider: AiProviderName
  apiKey: string
  model: string
  action: "save" | "test"
}

/**
 * The customer's AI page (Phase 5 — BYOK): one key per provider, a
 * Test button with every saved key, and the billing-mode selector.
 * Saving or testing a key opens the storage popup: "Browser only"
 * (this browser, never the server) or "Both (browser + server)"
 * (encrypted in the database, works from any device). A saved key's
 * value is never displayed — only its fingerprint's last 4 chars.
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

  /** The storage popup's "Both" choice: save encrypted on the server. */
  async function saveToServer(action: PendingStorageAction) {
    try {
      await saveKey.mutateAsync({
        provider: action.provider,
        apiKey: action.apiKey,
        model: action.model.trim() || undefined,
      })
      toast.success(t("keySaved"))
      setPending(null)
      if (action.action === "test") {
        await runServerTest(action.provider)
      }
    } catch (err) {
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
          {mode === "BYOK" && (
            <p className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
              {t("platformPausedNotice")}
            </p>
          )}
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
                <p className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
                  {t("byokNoKeyWarning")}
                </p>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

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

/**
 * The storage popup (the owner's design): when a user saves or tests
 * a key, they pick where it lives — "Browser only" (this browser,
 * never the server) or "Both (browser + server)" (encrypted in the
 * database, works from any device they sign in on).
 */
function StoragePopup({
  pending,
  onClose,
  onBrowserOnly,
  onBoth,
}: {
  pending: PendingStorageAction | null
  onClose: () => void
  onBrowserOnly: (action: PendingStorageAction) => void
  onBoth: (action: PendingStorageAction) => Promise<void>
}) {
  const { t } = useTranslation("ai")
  const [busy, setBusy] = useState(false)

  if (!pending) return null
  // Narrowed once here: function declarations are hoisted, so TS
  // would not narrow `pending` inside chooseBoth on its own.
  const action = pending

  async function chooseBoth() {
    setBusy(true)
    try {
      await onBoth(action)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("storageTitle")} — {PROVIDER_DISPLAY_NAMES[pending.provider]}
          </DialogTitle>
          <DialogDescription>{t("storageDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => onBrowserOnly(pending)}
            className="rounded-lg border p-4 text-start hover:bg-accent"
          >
            <span className="block text-sm font-semibold">
              {t("browserOnly")}
            </span>
            <span className="block text-sm text-muted-foreground">
              {t("browserOnlyDescription")}
            </span>
          </button>
          <button
            type="button"
            onClick={chooseBoth}
            disabled={busy}
            className="rounded-lg border p-4 text-start hover:bg-accent"
          >
            <span className="block text-sm font-semibold">{t("both")}</span>
            <span className="block text-sm text-muted-foreground">
              {t("bothDescription")}
            </span>
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProviderKeyCard({
  provider,
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
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {PROVIDER_DISPLAY_NAMES[provider]}
        </h3>
        <div className="flex gap-2">
          {serverKey && <Badge variant="secondary">{t("savedOnServer")}</Badge>}
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
    </div>
  )
}
