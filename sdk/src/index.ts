// SendCMS form SDK — entry point.
// Usage:
//   <script src="https://APP_URL/forms/v1.js"
//     data-user-id="USER_ID" data-form-id="FORM_ID"></script>
//   <form data-cms-form>
//     <input name="name" required>
//     <input name="email" type="email" required>
//     <textarea name="message" required></textarea>
//     <button type="submit">Send</button>
//   </form>
//
// The script auto-enhances every <form data-cms-form> on the page.
// A form can override the defaults with its own data-user-id /
// data-form-id / data-turnstile-site-key attributes, so several forms
// (even from different SendCMS accounts) can live on one page.
// Programmatic use: window.SendCMS.init({ userId, formId, ... }).

import { collectFormFields, setFormConfig } from "./enhance"
import { enhanceForm } from "./enhance"
import { buildSubmitPayload, submitToApi } from "./api"
import {
  DEFAULT_MESSAGES,
  HONEYPOT_FIELD,
  type ResolvedFormConfig,
  type SendCMSOptions,
  type SendCMSSubmitResult,
} from "./types"

declare const __APP_URL__: string

export const SDK_VERSION = "1.0.0"

// The script element that loaded this bundle — captured at evaluation
// time, because document.currentScript is null after load.
const scriptElement =
  typeof document !== "undefined"
    ? (document.currentScript as HTMLScriptElement | null)
    : null

function scriptOrigin(): string | null {
  if (!scriptElement?.src) return null
  try {
    return new URL(scriptElement.src).origin
  } catch {
    return null
  }
}

let globalOptions: SendCMSOptions = {}

function resolveConfig(
  form: HTMLFormElement,
  options: SendCMSOptions
): ResolvedFormConfig {
  const scriptData = scriptElement?.dataset ?? {}
  const formData = form.dataset
  return {
    userId: formData.userId ?? options.userId ?? scriptData.userId ?? "",
    formId: formData.formId ?? options.formId ?? scriptData.formId ?? "",
    apiUrl:
      options.apiUrl ??
      scriptOrigin() ??
      (typeof __APP_URL__ !== "undefined" ? __APP_URL__ : ""),
    turnstileSiteKey:
      formData.turnstileSiteKey ?? options.turnstileSiteKey ?? null,
    redirectUrl: options.redirectUrl ?? null,
    resetOnSuccess: options.resetOnSuccess ?? true,
    honeypot: options.honeypot ?? true,
    messages: {
      sending: options.messages?.sending ?? DEFAULT_MESSAGES.sending,
      success: options.messages?.success ?? DEFAULT_MESSAGES.success,
      error: options.messages?.error ?? DEFAULT_MESSAGES.error,
    },
    onSuccess: options.onSuccess,
    onError: options.onError,
    onSubmit: options.onSubmit,
  }
}

/** Enhances every matching form under root (default: the whole
    document). Forms already enhanced are skipped. */
export function scan(root: ParentNode = document): void {
  const forms = root.querySelectorAll<HTMLFormElement>("form[data-cms-form]")
  for (const form of forms) {
    enhanceForm(form, resolveConfig(form, globalOptions))
  }
}

/** Manual init — merges options into the global defaults, refreshes
    the config of forms that are already enhanced (so callbacks set
    after page load still apply), and scans the page. Auto-init calls
    this with the script tag's data. */
export function init(options: SendCMSOptions = {}): void {
  globalOptions = { ...globalOptions, ...options }
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-sc-enhanced]"
  )) {
    setFormConfig(form, resolveConfig(form, globalOptions))
  }
  scan()
}

/** Enhances a single form (e.g. one added by client-side routing).
    Returns true when the form was (or already is) enhanced. */
export function enhance(
  form: HTMLFormElement,
  options: SendCMSOptions = {}
): boolean {
  return enhanceForm(
    form,
    resolveConfig(form, { ...globalOptions, ...options })
  )
}

/** Submits a form's data without touching the DOM — for fully custom
    UIs. The fields record uses the form's field names as keys. */
export async function submit(
  form: HTMLFormElement,
  fields?: Record<string, unknown>
): Promise<SendCMSSubmitResult> {
  const config = resolveConfig(form, globalOptions)
  if (!config.userId || !config.formId) {
    throw new Error(
      "SendCMS: userId and formId are required — set them on the script tag, via init(), or on the form itself."
    )
  }
  const trap = form.querySelector<HTMLInputElement>(
    `[name="${HONEYPOT_FIELD}"]`
  )
  const payload = buildSubmitPayload(
    config.userId,
    config.formId,
    fields ?? collectFormFields(form),
    window.location.href,
    undefined,
    trap?.value
  )
  return submitToApi(config.apiUrl, payload)
}

const SendCMS = {
  init,
  enhance,
  submit,
  scan,
  version: SDK_VERSION,
}

declare global {
  interface Window {
    SendCMS?: typeof SendCMS
  }
}

if (typeof window !== "undefined") {
  window.SendCMS = SendCMS
}

function autoInit(): void {
  // The script tag's own data attributes are the defaults.
  const data = scriptElement?.dataset ?? {}
  init({
    userId: data.userId,
    formId: data.formId,
    turnstileSiteKey: data.turnstileSiteKey,
  })

  // SPA navigation + Astro view transitions: forms can appear after
  // the initial scan, so watch for them.
  if (typeof MutationObserver !== "undefined" && document.body) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches?.("form[data-cms-form]")) {
            enhanceForm(
              node as HTMLFormElement,
              resolveConfig(node as HTMLFormElement, globalOptions)
            )
          } else {
            scan(node)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
  document.addEventListener("astro:page-load", () => scan())
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit, { once: true })
  } else {
    autoInit()
  }
}

export default SendCMS
