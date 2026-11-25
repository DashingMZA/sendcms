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

import {
  collectFormFields,
  getFormIdempotencyKey,
  reconcileHoneypot,
  rotateFormIdempotencyKey,
  setFormConfig,
} from "./enhance"
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
declare const __SDK_VERSION__: string

// Diagnostic only: the bundle's version, derived from
// packages/sdk/package.json at build time (esbuild define) so it can
// never disagree with the package version. Nothing gates on it.
export const SDK_VERSION = __SDK_VERSION__

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

/** Drops `undefined`-valued keys so a later merge can never clobber
    an earlier value with `undefined` (e.g. autoInit passing the
    script tag's absent data attributes over an init() call). */
function dropUndefinedOptions(options: SendCMSOptions): SendCMSOptions {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) cleaned[key] = value
  }
  return cleaned as SendCMSOptions
}

let warnedEmptyApiUrl = false

function resolveConfig(
  form: HTMLFormElement,
  options: SendCMSOptions
): ResolvedFormConfig {
  const scriptData = scriptElement?.dataset ?? {}
  const formData = form.dataset
  const apiUrl =
    options.apiUrl ??
    scriptOrigin() ??
    (typeof __APP_URL__ !== "undefined" ? __APP_URL__ : "")
  if (!apiUrl && !warnedEmptyApiUrl) {
    warnedEmptyApiUrl = true
    console.warn(
      'SendCMS: could not determine the API URL — the bundle may be hosted on a CDN or imported from npm, so submissions would go to the wrong origin. Pass apiUrl to SendCMS.init({ apiUrl: "https://YOUR_API" }).'
    )
  }
  return {
    userId: formData.userId ?? options.userId ?? scriptData.userId ?? "",
    formId: formData.formId ?? options.formId ?? scriptData.formId ?? "",
    apiUrl,
    turnstileSiteKey:
      formData.turnstileSiteKey ?? options.turnstileSiteKey ?? null,
    redirectUrl: options.redirectUrl ?? null,
    resetOnSuccess: options.resetOnSuccess ?? true,
    honeypot: options.honeypot ?? true,
    messages: {
      sending: options.messages?.sending ?? DEFAULT_MESSAGES.sending,
      verifying: options.messages?.verifying ?? DEFAULT_MESSAGES.verifying,
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
    this with the script tag's data. `undefined` values are ignored,
    so init() can never wipe a value set by an earlier init(). */
export function init(options: SendCMSOptions = {}): void {
  globalOptions = { ...globalOptions, ...dropUndefinedOptions(options) }
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-sc-enhanced]"
  )) {
    const config = resolveConfig(form, globalOptions)
    setFormConfig(form, config)
    reconcileHoneypot(form, config.honeypot)
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
    UIs. The fields record uses the form's field names as keys. One
    idempotency key per form-fill (SRC-308): retries reuse the key
    until a confirmed success rotates it. Concurrent calls for the
    same form share the one in-flight request and return its result
    — the form is sent once. */
export async function submit(
  form: HTMLFormElement,
  fields?: Record<string, unknown>
): Promise<SendCMSSubmitResult> {
  const inFlight = inFlightSubmits.get(form)
  if (inFlight) return inFlight
  const promise = submitOnce(form, fields)
  inFlightSubmits.set(form, promise)
  try {
    return await promise
  } finally {
    if (inFlightSubmits.get(form) === promise) {
      inFlightSubmits.delete(form)
    }
  }
}

// In-flight programmatic submits, per form — concurrent submit()
// calls return the same promise instead of sending twice (SRC-308).
const inFlightSubmits = new WeakMap<
  HTMLFormElement,
  Promise<SendCMSSubmitResult>
>()

async function submitOnce(
  form: HTMLFormElement,
  fields?: Record<string, unknown>
): Promise<SendCMSSubmitResult> {
  const config = resolveConfig(form, globalOptions)
  if (!config.userId || !config.formId) {
    throw new Error(
      "SendCMS: userId and formId are required — set them on the script tag, via init(), or on the form itself."
    )
  }
  if (!config.apiUrl) {
    throw new Error(
      'SendCMS: apiUrl is empty — the bundle cannot tell where the API lives. Pass apiUrl to SendCMS.init({ apiUrl: "https://YOUR_API" }).'
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
    trap?.value,
    getFormIdempotencyKey(form)
  )
  const result = await submitToApi(config.apiUrl, payload)
  // Confirmed success — the next fill gets a fresh key. A failure
  // keeps the key, so a retry of this fill is deduplicated.
  rotateFormIdempotencyKey(form)
  return result
}

// The MutationObserver and the Astro listener installed by autoInit.
// Kept module-level so destroy() can tear them down.
let observer: MutationObserver | null = null
let astroHandler: (() => void) | null = null
let destroyed = false

/** Tears the SDK down: disconnects the observer, removes the Astro
    listener, resets the global options, and releases `window.SendCMS`
    so a later load of the bundle starts clean. Enhanced forms keep
    their submit handlers (the page is going away or the SDK is being
    replaced); call scan()/init() again after re-loading to enhance
    new forms. */
export function destroy(): void {
  destroyed = true
  observer?.disconnect()
  observer = null
  if (astroHandler) {
    document.removeEventListener("astro:page-load", astroHandler)
    astroHandler = null
  }
  globalOptions = {}
  warnedEmptyApiUrl = false
  if (typeof window !== "undefined" && window.SendCMS === SendCMS) {
    delete window.SendCMS
  }
}

const SendCMS = {
  init,
  enhance,
  submit,
  scan,
  destroy,
  version: SDK_VERSION,
}

declare global {
  interface Window {
    SendCMS?: typeof SendCMS
  }
}

// A second <script> tag (or a second bundle evaluation) must not
// split the SDK in two: the first evaluation owns the submit handlers
// and their config, so a later one keeps the existing public object
// and skips auto-init — otherwise init() callbacks set through the
// public object would never fire for forms the first load enhanced.
const alreadyLoaded = typeof window !== "undefined" && Boolean(window.SendCMS)

if (typeof window !== "undefined" && !alreadyLoaded) {
  window.SendCMS = SendCMS
}

function autoInit(): void {
  if (destroyed) return
  // The script tag's own data attributes are the defaults — only the
  // ones that exist, so absent attributes never wipe an init() call
  // made before DOMContentLoaded.
  const data = scriptElement?.dataset ?? {}
  const scriptOptions: SendCMSOptions = {}
  if (data.userId !== undefined) scriptOptions.userId = data.userId
  if (data.formId !== undefined) scriptOptions.formId = data.formId
  if (data.turnstileSiteKey !== undefined) {
    scriptOptions.turnstileSiteKey = data.turnstileSiteKey
  }
  init(scriptOptions)

  // SPA navigation + Astro view transitions: forms can appear after
  // the initial scan, so watch for them — including forms that gain
  // data-cms-form (or change ids) after load.
  if (typeof MutationObserver !== "undefined" && document.body) {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const target = mutation.target
          if (
            target instanceof HTMLFormElement &&
            target.matches("form[data-cms-form]")
          ) {
            enhanceForm(target, resolveConfig(target, globalOptions))
          }
          continue
        }
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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-cms-form",
        "data-form-id",
        "data-user-id",
        "data-turnstile-site-key",
      ],
    })
  }
  astroHandler = () => scan()
  document.addEventListener("astro:page-load", astroHandler)
}

if (typeof document !== "undefined" && !alreadyLoaded) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit, { once: true })
  } else {
    autoInit()
  }
}

export default SendCMS
