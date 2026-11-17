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

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback"

let scriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const previous = window.onloadTurnstileCallback
    window.onloadTurnstileCallback = () => {
      if (previous) previous()
      resolve()
    }
    const script = document.createElement("script")
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onerror = () => {
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
  try {
    const token = await new Promise<string>((resolve, reject) => {
      let widgetId = ""
      const timeout = setTimeout(() => {
        reject(new Error("Bot verification timed out. Please try again."))
      }, 30000)
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
    })
    return token
  } finally {
    holder.remove()
  }
}
