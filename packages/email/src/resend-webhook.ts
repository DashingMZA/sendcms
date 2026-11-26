import { createHmac, timingSafeEqual } from "node:crypto"

// Signed Resend webhook receiver (EML-005). Resend signs every
// webhook with Svix (the Standard Webhooks scheme): headers
// `svix-id` / `svix-timestamp` / `svix-signature`, secret
// `whsec_<base64>`, HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${rawBody}`. Verified here with node
// crypto — no new dependency. The timestamp is rejected when it is
// more than 5 minutes old (replay protection, Svix's own tolerance).

export type ResendWebhookEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.opened"
  | "email.clicked"

export type ResendWebhookEvent = {
  type: ResendWebhookEventType | string
  created_at: string
  data: {
    // Resend's id for the sent email — the same value the send API
    // returned as `id` and the outbox stores as providerMessageId.
    email_id: string
    from: string
    to: string[]
    subject: string
    bounce?: { type: "hard_bounce" | "transient" | string; message?: string }
    [key: string]: unknown
  }
}

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret
  return Buffer.from(raw, "base64")
}

/** Verifies a Svix-signed Resend webhook. `payload` must be the raw
    request body, byte-identical to what Resend signed. */
export function verifyResendWebhookSignature({
  payload,
  svixId,
  svixTimestamp,
  svixSignature,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  payload: string
  svixId: string | null
  svixTimestamp: string | null
  svixSignature: string | null
  secret: string
  nowSeconds?: number
}): boolean {
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false
  const timestamp = Number(svixTimestamp)
  if (!Number.isFinite(timestamp)) return false
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false
  }
  const signed = `${svixId}.${svixTimestamp}.${payload}`
  let expected: Buffer
  try {
    expected = createHmac("sha256", decodeSecret(secret))
      .update(signed, "utf8")
      .digest()
  } catch {
    return false
  }
  // `svix-signature` may carry several space-separated signatures;
  // any `v1,<base64>` entry that matches verifies the request.
  for (const entry of svixSignature.split(" ")) {
    const [version, value] = entry.split(",")
    if (version !== "v1" || !value) continue
    let actual: Buffer
    try {
      actual = Buffer.from(value, "base64")
    } catch {
      continue
    }
    if (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    ) {
      return true
    }
  }
  return false
}

/** Parses a verified webhook body. Returns null when the shape is
    not a Resend delivery event (unknown type, missing data). */
export function parseResendWebhookEvent(
  payload: string
): ResendWebhookEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const event = parsed as Record<string, unknown>
  if (typeof event.type !== "string") return null
  const data = event.data
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.email_id !== "string" || !d.email_id) return null
  if (!Array.isArray(d.to) || d.to.length === 0) return null
  return {
    type: event.type,
    created_at: typeof event.created_at === "string" ? event.created_at : "",
    data: {
      email_id: d.email_id,
      from: typeof d.from === "string" ? d.from : "",
      to: d.to.filter((t): t is string => typeof t === "string"),
      subject: typeof d.subject === "string" ? d.subject : "",
      ...(typeof d.bounce === "object" && d.bounce !== null
        ? { bounce: d.bounce as ResendWebhookEvent["data"]["bounce"] }
        : {}),
    },
  }
}

/** The delivery outcome a webhook type maps to, or null for events
    the outbox does not track (sent/opened/clicked). A soft
    (transient) bounce is NOT a suppression — only a hard bounce is. */
export function resendEventToDeliveryStatus(
  event: ResendWebhookEvent
): "DELIVERED" | "BOUNCED" | "COMPLAINED" | "DELIVERY_DELAYED" | null {
  switch (event.type) {
    case "email.delivered":
      return "DELIVERED"
    case "email.delivery_delayed":
      return "DELIVERY_DELAYED"
    case "email.complained":
      return "COMPLAINED"
    case "email.bounced":
      return event.data.bounce?.type === "transient" ? null : "BOUNCED"
    default:
      return null
  }
}
