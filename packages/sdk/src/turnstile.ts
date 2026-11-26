// Optional Cloudflare Turnstile support. Only used when the site
// owner configured a site key (data-turnstile-site-key / option) —
// otherwise the SDK never loads the Turnstile script at all.

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          size?: "invisible" | "normal" | "compact"
          callback?: (token: string) => void
          "error-callback"?: () => void
          "expired-callback"?: () => void
        }
      ) => string
      execute: (widgetId: string) => void
      remove: (widgetId: string) => void
      ready: (callback: () => void) => void
    }
    onloadTurnstileCallback?: () => void
  }
}

// Turnstile trust decision (SRC-328(b)): the script is loaded
// without SRI on purpose. Cloudflare serves api.js dynamically —
// the bytes change per request, so no stable hash exists to pin
// (this is the standard Turnstile integration, not an oversight).
// The trust boundary is the token, not the script: the token is
// verified server-side against Cloudflare, so a tampered script
// cannot forge a passing verification.
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback"

// The script load must not hang forever: a stalled CDN leaves the
// form on "Sending…" with the button disabled. Aligned with the
// 15 s submit timeout (SUBMIT_TIMEOUT_MS).
export const TURNSTILE_LOAD_TIMEOUT_MS = 15000
// The token wait runs before the submission fetch, so it must fit
// inside the same 15 s budget — not double it (SDK-039).
export const TURNSTILE_TOKEN_TIMEOUT_MS = 15000

let scriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const previous = window.onloadTurnstileCallback
    const script = document.createElement("script")
    const timer = setTimeout(() => {
      scriptPromise = null
      script.remove()
      reject(new Error("Could not load the bot verification script."))
    }, TURNSTILE_LOAD_TIMEOUT_MS)
    window.onloadTurnstileCallback = () => {
      clearTimeout(timer)
      if (previous) previous()
      resolve()
    }
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onerror = () => {
      clearTimeout(timer)
      scriptPromise = null
      reject(new Error("Could not load the bot verification script."))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/** Renders an invisible Turnstile widget inside the form and returns a
    fresh token. Fail closed: if the script cannot load or no token
    comes back, the submission is not sent. */
export async function getTurnstileToken(
  siteKey: string,
  form: HTMLFormElement
): Promise<string> {
  await loadTurnstileScript()
  if (!window.turnstile) {
    throw new Error("Bot verification is unavailable. Please try again.")
  }
  const turnstile = window.turnstile
  const holder = document.createElement("div")
  holder.setAttribute("aria-hidden", "true")
  form.appendChild(holder)
  let widgetId = ""
  try {
    const token = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Bot verification timed out. Please try again."))
      }, TURNSTILE_TOKEN_TIMEOUT_MS)
      try {
        widgetId = turnstile.render(holder, {
          sitekey: siteKey,
          size: "invisible",
          callback: (t: string) => {
            clearTimeout(timeout)
            resolve(t)
          },
          "error-callback": () => {
            clearTimeout(timeout)
            reject(new Error("Bot verification failed. Please try again."))
          },
          "expired-callback": () => {
            clearTimeout(timeout)
            reject(new Error("Bot verification expired. Please try again."))
          },
        })
        // Invisible widgets only produce a token on execute().
        turnstile.execute(widgetId)
      } catch (err) {
        // A synchronous render() throw must clear the timer, or it
        // leaks until it fires on an already-settled promise.
        clearTimeout(timeout)
        reject(err)
      }
    })
    return token
  } finally {
    // Tear the widget down through the Turnstile API, not just by
    // removing the holder div — and never let cleanup break the flow.
    if (widgetId) {
      try {
        turnstile.remove(widgetId)
      } catch {
        // Cleanup failure is not a submission failure.
      }
    }
    holder.remove()
  }
}
