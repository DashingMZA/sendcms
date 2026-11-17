// HTTP client for the public submission API. Pure fetch — no DOM, no
// globals beyond fetch / AbortController / crypto.

import type { SendCMSSubmitError, SendCMSSubmitResult } from "./types"
import { HONEYPOT_FIELD } from "./types"

export const SUBMIT_PATH = "/api/public/v1/submit"
export const SUBMIT_TIMEOUT_MS = 15000

export type SubmitPayload = {
  userId: string
  formId: string
  fields: Record<string, unknown>
  idempotencyKey: string
  pageUrl: string
  turnstileToken?: string
  /** Bot-trap value — sent at the top level so the server can spot
      bots. Empty for humans. */
  [HONEYPOT_FIELD]?: string
}

function newIdempotencyKey(): string {
  // crypto.randomUUID is available in all modern browsers; fall back to
  // a random hex string so the SDK never crashes on an old one.
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID()
  }
  return `sc-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

export function buildSubmitPayload(
  userId: string,
  formId: string,
  fields: Record<string, unknown>,
  pageUrl: string,
  turnstileToken?: string,
  honeypotValue?: string
): SubmitPayload {
  const payload: SubmitPayload = {
    userId,
    formId,
    fields,
    idempotencyKey: newIdempotencyKey(),
    pageUrl,
  }
  if (turnstileToken) payload.turnstileToken = turnstileToken
  if (honeypotValue !== undefined) payload[HONEYPOT_FIELD] = honeypotValue
  return payload
}

/** POSTs one submission. A fresh idempotency key is generated per
    call, so a retry after a network failure is not mistaken for a
    duplicate of the failed attempt. */
export async function submitToApi(
  apiUrl: string,
  payload: SubmitPayload
): Promise<SendCMSSubmitResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, "")}${SUBMIT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    throw {
      ok: false,
      status: 0,
      message: aborted
        ? "The request timed out. Please try again."
        : "Could not reach the server. Check your connection and try again.",
    } satisfies SendCMSSubmitError
  } finally {
    clearTimeout(timer)
  }

  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `Submission failed (${res.status}).`
    throw {
      ok: false,
      status: res.status,
      message,
    } satisfies SendCMSSubmitError
  }

  const body = data as {
    id?: unknown
    message?: unknown
    redirectUrl?: unknown
  }
  return {
    ok: true,
    id: typeof body.id === "string" ? body.id : "",
    message: typeof body.message === "string" ? body.message : "",
    redirectUrl: typeof body.redirectUrl === "string" ? body.redirectUrl : null,
  }
}
