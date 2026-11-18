// Form enhancement: wires one <form data-cms-form> to the public
// submission API with loading / success / error states, a honeypot
// bot trap, duplicate prevention and optional Turnstile.

import { buildSubmitPayload, submitToApi } from "./api"
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
    the API takes text only. */
export function collectFormFields(
  form: HTMLFormElement
): Record<string, unknown> {
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

function setSubmitting(
  form: HTMLFormElement,
  submitting: boolean,
  sendingLabel: string
): HTMLButtonElement | null {
  const button = form.querySelector<HTMLButtonElement>(
    'button[type="submit"], input[type="submit"]'
  )
  if (submitting) {
    form.setAttribute(SUBMITTING_ATTR, "1")
    if (button) {
      button.disabled = true
      button.setAttribute("aria-busy", "true")
      if (button instanceof HTMLButtonElement) {
        if (!button.dataset.scOriginalText) {
          button.dataset.scOriginalText = button.textContent ?? ""
        }
        button.textContent = sendingLabel
      }
    }
  } else {
    form.removeAttribute(SUBMITTING_ATTR)
    if (button) {
      button.disabled = false
      button.removeAttribute("aria-busy")
      if (
        button instanceof HTMLButtonElement &&
        button.dataset.scOriginalText !== undefined
      ) {
        button.textContent = button.dataset.scOriginalText
        delete button.dataset.scOriginalText
      }
    }
  }
  return button
}

/** Enhances one form. Idempotent — calling it twice on the same form
    is a no-op. Returns false when the form cannot be enhanced (no
    userId / formId resolved). */
export function enhanceForm(
  form: HTMLFormElement,
  config: ResolvedFormConfig
): boolean {
  if (form.hasAttribute(ENHANCED_ATTR)) return true
  if (!config.userId || !config.formId) return false
  form.setAttribute(ENHANCED_ATTR, "")
  setFormConfig(form, config)
  ensureStyles()

  if (config.honeypot && !form.querySelector(`[name="${HONEYPOT_FIELD}"]`)) {
    const trap = document.createElement("input")
    trap.type = "text"
    trap.name = HONEYPOT_FIELD
    trap.className = "sc-honeypot"
    trap.setAttribute("aria-hidden", "true")
    trap.setAttribute("tabindex", "-1")
    trap.setAttribute("autocomplete", "off")
    form.appendChild(trap)
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    // Duplicate prevention: ignore submits while one is in flight.
    if (form.hasAttribute(SUBMITTING_ATTR)) return

    // Read the live config — init() may have replaced it since the
    // form was enhanced (e.g. callbacks registered after page load).
    const live = getFormConfig(form) ?? config
    safeCall(() => live.onSubmit?.(form))
    setSubmitting(form, true, live.messages.sending)
    showStatus(form, "sending", live.messages.sending)

    try {
      let turnstileToken: string | undefined
      if (live.turnstileSiteKey) {
        turnstileToken = await getTurnstileToken(live.turnstileSiteKey, form)
      }

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
        trap?.value
      )
      const result = await submitToApi(live.apiUrl, payload)

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
