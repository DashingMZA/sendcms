// Form enhancement: wires one <form data-cms-form> to the public
// submission API with loading / success / error states, a honeypot
// bot trap, duplicate prevention and optional Turnstile.

import { buildSubmitPayload, newIdempotencyKey, submitToApi } from "./api"
import { ensureStyles } from "./styles"
import { getTurnstileToken } from "./turnstile"
import {
  HONEYPOT_FIELD,
  type ResolvedFormConfig,
  type SendCMSSubmitError,
} from "./types"

const ENHANCED_ATTR = "data-sc-enhanced"
const SUBMITTING_ATTR = "data-sc-submitting"

// The live config per form. init() can replace it after enhancement
// (e.g. a site that registers callbacks after the SDK loaded), so the
// submit handler always reads the current config from here, not from
// the closure captured at enhance time.
const formConfigs = new WeakMap<HTMLFormElement, ResolvedFormConfig>()

export function setFormConfig(
  form: HTMLFormElement,
  config: ResolvedFormConfig
): void {
  formConfigs.set(form, config)
}

function getFormConfig(form: HTMLFormElement): ResolvedFormConfig | undefined {
  return formConfigs.get(form)
}

// One idempotency key per form-fill (SRC-308): the key is minted on
// the first submit of a fill and reused across retries of that fill,
// so a retry after a successful-but-unacknowledged submit is
// deduplicated by the server instead of creating a second
// submission. It rotates only after a confirmed success — a failed
// attempt keeps the key for the next retry.
const formIdempotencyKeys = new WeakMap<HTMLFormElement, string>()

export function getFormIdempotencyKey(form: HTMLFormElement): string {
  const existing = formIdempotencyKeys.get(form)
  if (existing) return existing
  const key = newIdempotencyKey()
  formIdempotencyKeys.set(form, key)
  return key
}

export function rotateFormIdempotencyKey(form: HTMLFormElement): void {
  formIdempotencyKeys.delete(form)
}

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return
  try {
    fn()
  } catch {
    // A throwing callback must never break the submission flow.
  }
}

/** Collects the form's fields into the API's record shape. Repeated
    names (checkbox groups) become arrays; file inputs are skipped —
    the API takes text only (warned once per form); disabled inputs
    are excluded, like FormData itself excludes them. */
export function collectFormFields(
  form: HTMLFormElement
): Record<string, unknown> {
  warnForFileInputs(form)
  const data = new FormData(form)
  const fields: Record<string, unknown> = {}
  for (const [key, value] of data.entries()) {
    if (key === HONEYPOT_FIELD) continue
    if (typeof value !== "string") continue
    const existing = fields[key]
    if (existing === undefined) {
      fields[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      fields[key] = [existing, value]
    }
  }
  return fields
}

const warnedFileForms = new WeakSet<HTMLFormElement>()

/** Warns once per form when it contains a file input: the API takes
    text only, so the file is never sent (see docs/sdk.md). */
function warnForFileInputs(form: HTMLFormElement): void {
  if (warnedFileForms.has(form)) return
  if (!form.querySelector('input[type="file"]')) return
  warnedFileForms.add(form)
  console.warn(
    "SendCMS: this form has a file input, but file uploads are not supported — the file will not be sent. See docs/sdk.md."
  )
}

/** Adds or removes the honeypot trap so it always matches `enabled`
    — including when init() toggles it after the form was enhanced. */
export function reconcileHoneypot(
  form: HTMLFormElement,
  enabled: boolean
): void {
  const trap = form.querySelector(`[name="${HONEYPOT_FIELD}"]`)
  if (!enabled) {
    trap?.remove()
    return
  }
  if (trap) return
  const input = document.createElement("input")
  input.type = "text"
  input.name = HONEYPOT_FIELD
  input.className = "sc-honeypot"
  input.setAttribute("aria-hidden", "true")
  input.setAttribute("tabindex", "-1")
  input.setAttribute("autocomplete", "off")
  form.appendChild(input)
}

function getStatusElement(form: HTMLFormElement): HTMLDivElement {
  const existing = form.querySelector<HTMLDivElement>(".sc-status")
  if (existing) return existing
  const el = document.createElement("div")
  el.className = "sc-status"
  el.setAttribute("role", "status")
  el.setAttribute("aria-live", "polite")
  form.appendChild(el)
  return el
}

function showStatus(
  form: HTMLFormElement,
  kind: "sending" | "success" | "error",
  text: string
): void {
  const el = getStatusElement(form)
  el.textContent = text
  el.className = `sc-status sc-status--visible sc-status--${kind}`
}

/** Disables every submit control while sending and shows the sending
    label on each of them — `<button>` via textContent, `<input
    type="submit">` via value — then restores both. */
function setSubmitting(
  form: HTMLFormElement,
  submitting: boolean,
  sendingLabel: string
): void {
  const controls = form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
    'button[type="submit"], input[type="submit"]'
  )
  if (submitting) {
    form.setAttribute(SUBMITTING_ATTR, "1")
    for (const control of controls) {
      control.disabled = true
      control.setAttribute("aria-busy", "true")
      if (control instanceof HTMLButtonElement) {
        if (control.dataset.scOriginalText === undefined) {
          control.dataset.scOriginalText = control.textContent ?? ""
        }
        control.textContent = sendingLabel
      } else {
        if (control.dataset.scOriginalValue === undefined) {
          control.dataset.scOriginalValue = control.value
        }
        control.value = sendingLabel
      }
    }
  } else {
    form.removeAttribute(SUBMITTING_ATTR)
    for (const control of controls) {
      control.disabled = false
      control.removeAttribute("aria-busy")
      if (
        control instanceof HTMLButtonElement &&
        control.dataset.scOriginalText !== undefined
      ) {
        control.textContent = control.dataset.scOriginalText
        delete control.dataset.scOriginalText
      } else if (
        control instanceof HTMLInputElement &&
        control.dataset.scOriginalValue !== undefined
      ) {
        control.value = control.dataset.scOriginalValue
        delete control.dataset.scOriginalValue
      }
    }
  }
}

/** Enhances one form. Idempotent — calling it twice on the same form
    refreshes its config (so callbacks/options set after page load
    still apply) instead of silently ignoring the new options.
    Returns false when the form cannot be enhanced (no userId /
    formId resolved). */
export function enhanceForm(
  form: HTMLFormElement,
  config: ResolvedFormConfig
): boolean {
  if (form.hasAttribute(ENHANCED_ATTR)) {
    // Re-verify the styles on every pass: if the host page removed
    // the <style data-sendcms> element, it is re-injected here.
    ensureStyles()
    // Refresh the live config — but never clobber good ids with
    // empty ones (e.g. enhance() called with no ids anywhere).
    if (config.userId && config.formId) setFormConfig(form, config)
    reconcileHoneypot(form, config.honeypot)
    return true
  }
  if (!config.userId || !config.formId) {
    const missing = [
      !config.userId ? "userId" : null,
      !config.formId ? "formId" : null,
    ]
      .filter((m): m is string => m !== null)
      .join(" and ")
    console.warn(
      `SendCMS: not enhancing form — missing ${missing}. Set data-user-id / data-form-id on the form or the script tag, or pass them to SendCMS.init(). Without them the form submits natively and nothing arrives. Form: ${form.outerHTML.slice(0, 200)}`
    )
    return false
  }
  form.setAttribute(ENHANCED_ATTR, "")
  setFormConfig(form, config)
  ensureStyles()
  reconcileHoneypot(form, config.honeypot)
  warnForFileInputs(form)

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    // Duplicate prevention: ignore submits while one is in flight.
    if (form.hasAttribute(SUBMITTING_ATTR)) return

    // Read the live config — init() may have replaced it since the
    // form was enhanced (e.g. callbacks registered after page load).
    const live = getFormConfig(form) ?? config
    safeCall(() => live.onSubmit?.(form))
    setSubmitting(form, true, live.messages.sending)
    try {
      let turnstileToken: string | undefined
      if (live.turnstileSiteKey) {
        // Distinct progress while the token is fetched — the token
        // wait runs before the submission, so "Sending…" alone would
        // hide up to 15 s of bot verification.
        showStatus(form, "sending", live.messages.verifying)
        turnstileToken = await getTurnstileToken(live.turnstileSiteKey, form)
      }
      showStatus(form, "sending", live.messages.sending)

      const fields = collectFormFields(form)
      // The honeypot lives at the top level of the payload, not inside
      // fields — read it straight off the trap input (empty for humans).
      const trap = form.querySelector<HTMLInputElement>(
        `[name="${HONEYPOT_FIELD}"]`
      )
      const payload = buildSubmitPayload(
        live.userId,
        live.formId,
        fields,
        window.location.href,
        turnstileToken,
        trap?.value,
        getFormIdempotencyKey(form)
      )
      const result = await submitToApi(live.apiUrl, payload)

      // Confirmed success — the next fill gets a fresh key.
      rotateFormIdempotencyKey(form)
      setSubmitting(form, false, live.messages.sending)
      showStatus(form, "success", result.message || live.messages.success)
      if (live.resetOnSuccess) form.reset()
      safeCall(() => live.onSuccess?.(result, form))

      const redirectUrl = result.redirectUrl ?? live.redirectUrl
      if (redirectUrl) {
        window.location.assign(redirectUrl)
      }
    } catch (err) {
      setSubmitting(form, false, live.messages.sending)
      const error = err as SendCMSSubmitError
      const message = error?.message || live.messages.error
      showStatus(form, "error", message)
      safeCall(() =>
        live.onError?.(
          {
            ok: false,
            status: error?.status ?? 0,
            message,
          },
          form
        )
      )
    }
  })

  return true
}
