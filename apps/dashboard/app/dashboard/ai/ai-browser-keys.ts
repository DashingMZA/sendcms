import type { AiProviderName } from "@sendcms/ai"

// ─── Browser-only keys (localStorage) ──────────────────────────────────
// A browser-only key lives ONLY in this browser: localStorage under
// one key per provider. It is sent per request for capability calls
// (browserKey) and never reaches the server for storage, so
// background jobs (spam re-scoring, digests) cannot use it. The
// plaintext is read from localStorage only inside an event handler,
// never kept in React state, and never displayed.
//
// (Wave 10, SRC-118: split out of ai-manager.tsx by concern.)
const BROWSER_KEY_PREFIX = "sendcms:ai:browser-key:"

export type BrowserKeyMeta = { model: string | null; savedAt: string }

function browserKeyStorageKey(provider: AiProviderName): string {
  return `${BROWSER_KEY_PREFIX}${provider}`
}

export function readBrowserKeyMeta(
  provider: AiProviderName
): BrowserKeyMeta | null {
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

export function readBrowserKeyValue(provider: AiProviderName): string | null {
  try {
    const raw = localStorage.getItem(browserKeyStorageKey(provider))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { apiKey?: unknown }
    return typeof parsed.apiKey === "string" ? parsed.apiKey : null
  } catch {
    return null
  }
}

export function writeBrowserKey(
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

export function removeBrowserKey(provider: AiProviderName): void {
  localStorage.removeItem(browserKeyStorageKey(provider))
}
