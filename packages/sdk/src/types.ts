// Public types for the SendCMS form SDK (packages/sdk/src).
// Dependency-free vanilla TypeScript — no framework, no imports from
// the Next.js app, except the honeypot field name from
// @sendcms/shared/constants (inlined into the bundle at build time).
// The bundle is built by packages/sdk/build.ts.

import { HONEYPOT_FIELD } from "@sendcms/shared/constants"

// The honeypot field name is the shared server/SDK contract (see
// @sendcms/shared constants) — re-exported so the SDK's api.ts keeps
// importing it from here.
export { HONEYPOT_FIELD }

export type SendCMSMessages = {
  /** Shown on the submit button while a submission is in flight. */
  sending?: string
  /** Shown when the server returns a success message of its own — the
      server's message wins; this is the fallback. */
  success?: string
  /** Shown when the submission fails and the server gave no message. */
  error?: string
}

export type SendCMSSubmitResult = {
  ok: true
  /** The submission id (or the deduplicated original's id). */
  id: string
  message: string
  redirectUrl: string | null
}

export type SendCMSSubmitError = {
  ok: false
  status: number
  message: string
}

export type SendCMSOptions = {
  /** Public user id (the form owner's id). Defaults to the <script>
      tag's data-user-id. */
  userId?: string
  /** Public form id. Defaults to the <script> tag's data-form-id. */
  formId?: string
  /** Base URL of the SendCMS app. Defaults to the origin of the
      <script> tag that loaded this bundle, else the compile-time
      __APP_URL__. */
  apiUrl?: string
  /** Cloudflare Turnstile site key. Only set it when the form has
      Turnstile enabled — the SDK then fetches a token on submit. */
  turnstileSiteKey?: string
  /** Override the success redirect (the form's redirectUrl wins when
      the server returns one). */
  redirectUrl?: string
  /** Reset the form after a successful submission. Default true. */
  resetOnSuccess?: boolean
  /** Add the hidden honeypot field (bot trap). Default true. */
  honeypot?: boolean
  messages?: SendCMSMessages
  /** Called with the result after a successful submission. */
  onSuccess?: (result: SendCMSSubmitResult, form: HTMLFormElement) => void
  /** Called with the error after a failed submission. */
  onError?: (error: SendCMSSubmitError, form: HTMLFormElement) => void
  /** Called right before a submission is sent. */
  onSubmit?: (form: HTMLFormElement) => void
}

/** Resolved per-form config: script defaults < init options < the
    form's own data-* attributes. */
export type ResolvedFormConfig = {
  userId: string
  formId: string
  apiUrl: string
  turnstileSiteKey: string | null
  redirectUrl: string | null
  resetOnSuccess: boolean
  honeypot: boolean
  messages: Required<SendCMSMessages>
  onSuccess: SendCMSOptions["onSuccess"]
  onError: SendCMSOptions["onError"]
  onSubmit: SendCMSOptions["onSubmit"]
}

export const DEFAULT_MESSAGES: Required<SendCMSMessages> = {
  sending: "Sending…",
  success: "Thanks! Your message has been sent.",
  error: "Something went wrong. Please try again.",
}
