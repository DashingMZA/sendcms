// Phase 16, Wave 8 — Stream A (Billing P1 core).
//
// TST-005: Polar webhook regression tests for BIL-040 (the P0 —
// `validateEvent` called without `await`, so every Polar webhook was
// silently ignored and a forged one was 200-acked). Wave 1 added the
// first Polar tests (valid signature, dedupe, bad signature,
// past-due); this file closes the remaining gaps: the one-time grant
// (BIL-042), refunds / past-due / updates (BIL-047/005), forged and
// tampered payloads (never 200-acked as "ignored"), malformed and
// unknown-type payloads, and unmapped paid checkouts left
// unprocessed (BIL-100). Signatures are computed for real with the
// Svix scheme against the real installed SDK; only the database,
// the audit writer, and the plans functions are stubbed. No test
// hits the real DB, a real provider, or the network.
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockCancel = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))
const mockApplyRefund = vi.hoisted(() => vi.fn(async () => null))
const mockSync = vi.hoisted(() => vi.fn(async () => null))

const { store, mockDb } = vi.hoisted(() => {
  type StoredEvent = {
    id: string
    provider: string
    providerEventId: string
    eventType: string
    userId: string | null
    processedAt: Date | null
    createdAt: Date
  }
  const store = {
    events: new Map<string, StoredEvent>(),
    eventSeq: 1,
  }
  const mockDb = {
    billingEvent: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            provider_providerEventId: {
              provider: string
              providerEventId: string
            }
          }
        }) =>
          store.events.get(
            `${where.provider_providerEventId.provider}:${where.provider_providerEventId.providerEventId}`
          ) ?? null
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            provider: string
            providerEventId: string
            eventType: string
            userId?: string | null
          }
        }) => {
          const row: StoredEvent = {
            id: `evt-${store.eventSeq++}`,
            processedAt: null,
            createdAt: new Date(),
            userId: data.userId ?? null,
            ...data,
          }
          store.events.set(`${data.provider}:${data.providerEventId}`, row)
          return row
        }
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: { processedAt?: Date; userId?: string }
        }) => {
          const row = [...store.events.values()].find((e) => e.id === where.id)
          if (!row) throw new Error("not found")
          if (data.processedAt !== undefined) row.processedAt = data.processedAt
          if (data.userId !== undefined) row.userId = data.userId
          return row
        }
      ),
    },
    user: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    subscription: { findFirst: vi.fn(async () => null) },
    oneTimePurchase: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockDb)
    ),
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return {
    ...actual,
    activateSubscriptionFromCheckout: mockActivate,
    applyRefund: mockApplyRefund,
    cancelSubscriptionFromProvider: mockCancel,
    extendSubscriptionPeriod: mockExtend,
    markSubscriptionPastDue: mockMarkPastDue,
    syncSubscriptionFromProvider: mockSync,
  }
})

import { handleWebhook } from "@sendcms/billing"

const SECRET = "whsec_polar_test_secret"
const WRONG_SECRET = "whsec_wrong_secret"

const savedEnv: Record<string, string | undefined> = {}
function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// Standard Webhooks signing: v1,base64(HMAC-SHA256(secret,
// "<webhook-id>.<timestamp>.<body>")) — verified against the real
// installed SDK before these tests were written.
function polarHeaders(id: string, payload: string, secret: string = SECRET) {
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = `v1,${createHmac("sha256", secret)
    .update(`${id}.${ts}.${payload}`)
    .digest("base64")}`
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": signature,
  }
}

function polarPayload(
  type: string,
  data: Record<string, unknown>,
  id?: string
) {
  return JSON.stringify({
    ...(id ? { id } : {}),
    type,
    timestamp: new Date().toISOString(),
    api_version: "2026-10",
    data,
  })
}

beforeEach(() => {
  store.events.clear()
  vi.clearAllMocks()
  setEnv({ POLAR_WEBHOOK_SECRET: SECRET })
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
})

describe("Polar one-time grant (BIL-042 — owner decision 2026-11-25)", () => {
  it("grants a one-time checkout.updated via the order id (no subscription)", async () => {
    const payload = polarPayload(
      "checkout.updated",
      {
        id: "co_one_1",
        status: "confirmed",
        subscription_id: null,
        order_id: "order_one_1",
        metadata: { user_id: "user-1", plan_version_id: "pv-1" },
      },
      "evt_one_1"
    )
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_one_1", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "checkout-completed",
    })
    expect(mockActivate).toHaveBeenCalledTimes(1)
    expect(mockActivate).toHaveBeenCalledWith({
      userId: "user-1",
      planVersionId: "pv-1",
      provider: "POLAR",
      providerSubscriptionId: "order_one_1",
      periodEnd: null,
      isOneTime: true,
      providerReference: "order_one_1",
      checkoutId: "co_one_1",
    })
  })

  it("grants a one-time order.paid via the order id", async () => {
    const payload = polarPayload("order.paid", {
      id: "order_one_2",
      subscription_id: null,
      checkout_id: "co_one_2",
      metadata: { user_id: "user-1", plan_version_id: "pv-1" },
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_one_2", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "checkout-completed",
    })
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSubscriptionId: "order_one_2",
        isOneTime: true,
        providerReference: "order_one_2",
        checkoutId: "co_one_2",
      })
    )
  })

  it("does NOT 422 a one-time checkout — the grant lands (BIL-042 decision)", async () => {
    const payload = polarPayload(
      "checkout.updated",
      {
        id: "co_one_3",
        status: "succeeded",
        metadata: { user_id: "user-1", plan_version_id: "pv-1" },
      },
      "evt_one_3"
    )
    // No subscription_id field at all and no order_id — the checkout
    // id itself is the order reference.
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_one_3", payload)
    )
    expect(result).toMatchObject({ received: true })
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSubscriptionId: "co_one_3",
        isOneTime: true,
      })
    )
  })
})

describe("Polar refunds + lifecycle (BIL-047 / BIL-005)", () => {
  it("maps a full order.refunded to applyRefund fullRefund: true", async () => {
    const payload = polarPayload("order.refunded", {
      id: "order_1",
      order_id: "order_1",
      subscription_id: "sub_pol_1",
      total_amount: 9900,
      refunded_amount: 9900,
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_ref_1", payload)
    )
    expect(result).toMatchObject({ received: true, kind: "payment-refunded" })
    expect(mockApplyRefund).toHaveBeenCalledWith(
      "POLAR",
      expect.objectContaining({
        providerSubscriptionId: "sub_pol_1",
        providerReference: "order_1",
        fullRefund: true,
        amountMinor: 9900,
      })
    )
  })

  it("maps a partial order.refunded to applyRefund fullRefund: false", async () => {
    const payload = polarPayload("order.refunded", {
      id: "order_2",
      order_id: "order_2",
      subscription_id: "sub_pol_1",
      total_amount: 9900,
      refunded_amount: 2000,
    })
    await handleWebhook("POLAR", payload, polarHeaders("msg_ref_2", payload))
    expect(mockApplyRefund).toHaveBeenCalledWith(
      "POLAR",
      expect.objectContaining({ fullRefund: false, amountMinor: 2000 })
    )
  })

  it("maps subscription.past_due to a payment failure", async () => {
    const payload = polarPayload("subscription.past_due", {
      id: "sub_pol_1",
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_pd_1", payload)
    )
    expect(result).toMatchObject({ received: true, kind: "payment-failed" })
    expect(mockMarkPastDue).toHaveBeenCalledWith("POLAR", "sub_pol_1")
  })

  it("maps a canceled subscription.updated to a cancel", async () => {
    const payload = polarPayload("subscription.updated", {
      id: "sub_pol_1",
      status: "canceled",
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_upd_1", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-canceled",
    })
    expect(mockCancel).toHaveBeenCalledWith(
      "POLAR",
      "sub_pol_1",
      expect.stringContaining("Polar")
    )
  })

  it("syncs an active subscription.updated (period end + cancel flag)", async () => {
    const payload = polarPayload("subscription.updated", {
      id: "sub_pol_1",
      status: "active",
      current_period_end: "2027-01-01T00:00:00.000Z",
      cancel_at_period_end: true,
    })
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_upd_2", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "subscription-updated",
    })
    expect(mockSync).toHaveBeenCalledWith(
      "POLAR",
      "sub_pol_1",
      expect.objectContaining({
        status: "active",
        periodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      })
    )
  })
})

describe("Polar forgery + malformed payloads (BIL-040 — never 200-acked as ignored)", () => {
  async function expectRejected(
    payload: string,
    headers: Record<string, string>
  ) {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on("unhandledRejection", onRejection)
    try {
      await expect(
        handleWebhook("POLAR", payload, headers)
      ).rejects.toMatchObject({
        status: 401,
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
    expect(mockActivate).not.toHaveBeenCalled()
    expect(mockCancel).not.toHaveBeenCalled()
    expect(mockExtend).not.toHaveBeenCalled()
  }

  it("rejects a payload signed with the wrong secret (forged)", async () => {
    const payload = polarPayload(
      "checkout.updated",
      {
        id: "co_forged",
        status: "confirmed",
        subscription_id: "sub_forged",
        metadata: { user_id: "user-1", plan_version_id: "pv-1" },
      },
      "evt_forged"
    )
    await expectRejected(
      payload,
      polarHeaders("msg_forged", payload, WRONG_SECRET)
    )
  })

  it("rejects a body tampered with after signing", async () => {
    const original = polarPayload(
      "checkout.updated",
      {
        id: "co_tampered",
        status: "confirmed",
        subscription_id: "sub_tampered",
        metadata: { user_id: "user-1", plan_version_id: "pv-1" },
      },
      "evt_tampered"
    )
    const headers = polarHeaders("msg_tampered", original)
    const tampered = original.replace("sub_tampered", "sub_attacker")
    await expectRejected(tampered, headers)
  })

  it("rejects a malformed (non-JSON) body", async () => {
    await expectRejected("this is not json", {
      "webhook-id": "msg_malformed",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1,badbadbadbad",
    })
  })

  it("rejects an unknown event type even with a valid signature", async () => {
    const payload = polarPayload("checkout.deleted", {
      id: "co_unknown",
    })
    await expectRejected(payload, polarHeaders("msg_unknown", payload))
  })

  it("rejects a payload missing the Svix headers", async () => {
    const payload = polarPayload("checkout.updated", {
      id: "co_noheaders",
      status: "confirmed",
      subscription_id: "sub_x",
      metadata: { user_id: "user-1", plan_version_id: "pv-1" },
    })
    await expectRejected(payload, {})
  })
})

describe("Polar unmapped paid checkout (BIL-100)", () => {
  it("leaves a confirmed checkout with no metadata unprocessed", async () => {
    const payload = polarPayload(
      "checkout.updated",
      {
        id: "co_unmapped",
        status: "confirmed",
        subscription_id: "sub_unmapped",
      },
      "evt_unmapped"
    )
    const result = await handleWebhook(
      "POLAR",
      payload,
      polarHeaders("msg_unmapped", payload)
    )
    expect(result).toMatchObject({
      received: true,
      kind: "unmapped-payment",
    })
    expect(mockActivate).not.toHaveBeenCalled()
    const row = store.events.get("POLAR:msg_unmapped")
    expect(row).toBeDefined()
    expect(row?.processedAt).toBeNull()
  })
})
