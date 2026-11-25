// Phase 16, Wave 6 — Stream A (customer billing).
//
// BIL-092 completion: listMyBillingEvents is owner-scoped (a customer
// sees only their own events), and handleWebhook attributes each
// event to its user — from the checkout event's buyer, or from the
// subscription row for renewals/failures/cancels — so the customer
// payment-history view has something owner-scoped to read. Ignored
// events carry no user.
//
// Billing service with a mocked Prisma client, mocked plans webhook
// functions, and a mocked provider verifier. No test hits the real
// DB, a real provider, or the network.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockActivate = vi.hoisted(() => vi.fn(async () => null))
const mockCancel = vi.hoisted(() => vi.fn(async () => null))
const mockExtend = vi.hoisted(() => vi.fn(async () => null))
const mockMarkPastDue = vi.hoisted(() => vi.fn(async () => null))
const mockVerify = vi.hoisted(() => vi.fn())

type StoredEvent = {
  id: string
  provider: string
  providerEventId: string
  eventType: string
  userId: string | null
  processedAt: Date | null
  createdAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    events: new Map<string, StoredEvent>(),
    subscriptions: new Map<string, { userId: string }>(),
    eventSeq: 1,
  }

  function matchesEventWhere(
    event: StoredEvent,
    where?: {
      userId?: string
      provider?: string
      eventType?: string
      processedAt?: { not: null } | null
      createdAt?: { gte?: Date; lte?: Date }
    }
  ): boolean {
    if (!where) return true
    if (where.userId !== undefined && event.userId !== where.userId)
      return false
    if (where.provider !== undefined && event.provider !== where.provider)
      return false
    if (where.eventType !== undefined && event.eventType !== where.eventType)
      return false
    if (where.processedAt !== undefined) {
      if (where.processedAt === null && event.processedAt !== null) return false
      if (
        typeof where.processedAt === "object" &&
        where.processedAt !== null &&
        "not" in where.processedAt &&
        event.processedAt === null
      )
        return false
    }
    if (where.createdAt?.gte && event.createdAt < where.createdAt.gte)
      return false
    if (where.createdAt?.lte && event.createdAt > where.createdAt.lte)
      return false
    return true
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredEvent = {
          id: `ev-${store.eventSeq++}`,
          provider: data.provider as string,
          providerEventId: data.providerEventId as string,
          eventType: data.eventType as string,
          userId: (data.userId as string | null | undefined) ?? null,
          processedAt: null,
          createdAt: new Date(),
        }
        store.events.set(`${row.provider}:${row.providerEventId}`, row)
        return row
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = [...store.events.values()].find((e) => e.id === where.id)
          if (!row) throw new Error("not found")
          Object.assign(row, data)
          return row
        }
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          [...store.events.values()].filter((e) =>
            matchesEventWhere(
              e,
              where as Parameters<typeof matchesEventWhere>[1]
            )
          ).length
      ),
      findMany: vi.fn(
        async ({
          where,
          skip = 0,
          take,
        }: {
          where?: Record<string, unknown>
          skip?: number
          take?: number
        }) => {
          const rows = [...store.events.values()]
            .filter((e) =>
              matchesEventWhere(
                e,
                where as Parameters<typeof matchesEventWhere>[1]
              )
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          return take === undefined
            ? rows.slice(skip)
            : rows.slice(skip, skip + take)
        }
      ),
    },
    subscription: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            provider?: string
            providerSubscriptionId?: string
          }
        }) =>
          store.subscriptions.get(
            `${where.provider}:${where.providerSubscriptionId}`
          ) ?? null
      ),
    },
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})
vi.mock("@sendcms/plans", () => ({
  activateSubscriptionFromCheckout: mockActivate,
  cancelSubscriptionFromProvider: mockCancel,
  extendSubscriptionPeriod: mockExtend,
  markSubscriptionPastDue: mockMarkPastDue,
}))
vi.mock("../packages/modules/billing/src/providers", () => ({
  verifyWebhookForProvider: mockVerify,
  createCheckoutForProvider: vi.fn(),
  getFreemiusPlanMapCount: () => 0,
}))

import {
  handleWebhook,
  listBillingEvents,
  listMyBillingEvents,
} from "@sendcms/billing"

function seedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  const row: StoredEvent = {
    id: `ev-${store.eventSeq++}`,
    provider: "STRIPE",
    providerEventId: `evt-${store.eventSeq}`,
    eventType: "checkout.session.completed",
    userId: "user-1",
    processedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  }
  store.events.set(`${row.provider}:${row.providerEventId}`, row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  store.events.clear()
  store.subscriptions.clear()
  store.eventSeq = 1
  mockVerify.mockResolvedValue({
    eventId: "evt-1",
    eventType: "checkout.session.completed",
    event: {
      kind: "checkout-completed",
      userId: "user-1",
      planVersionId: "pv-free",
      providerSubscriptionId: "sub_1",
      periodEnd: null,
    },
  })
})

describe("listMyBillingEvents (BIL-092 completion)", () => {
  it("returns only the caller's events", async () => {
    seedEvent({ userId: "user-1", providerEventId: "evt-a" })
    seedEvent({ userId: "user-2", providerEventId: "evt-b" })
    seedEvent({ userId: null, providerEventId: "evt-c" })
    const page = await listMyBillingEvents("user-1", {
      page: 1,
      perPage: 20,
    })
    expect(page.total).toBe(1)
    expect(page.events).toHaveLength(1)
    expect(page.events[0].userId).toBe("user-1")
    expect(page.events[0].providerEventId).toBe("evt-a")
  })

  it("still honors the provider filter inside the owner scope", async () => {
    seedEvent({
      userId: "user-1",
      provider: "STRIPE",
      providerEventId: "evt-a",
    })
    seedEvent({
      userId: "user-1",
      provider: "PAYPAL",
      providerEventId: "evt-b",
    })
    const page = await listMyBillingEvents("user-1", {
      page: 1,
      perPage: 20,
      provider: "PAYPAL",
    })
    expect(page.total).toBe(1)
    expect(page.events[0].provider).toBe("PAYPAL")
  })

  it("returns an empty page (not another user's rows) for a user with no events", async () => {
    seedEvent({ userId: "user-2", providerEventId: "evt-a" })
    const page = await listMyBillingEvents("user-1", {
      page: 1,
      perPage: 20,
    })
    expect(page.total).toBe(0)
    expect(page.events).toEqual([])
  })
})

describe("listBillingEvents carries userId (admin side)", () => {
  it("maps userId onto the admin rows", async () => {
    seedEvent({ userId: "user-1", providerEventId: "evt-a" })
    const page = await listBillingEvents(makeSession(), {
      page: 1,
      perPage: 20,
    })
    expect(page.events[0].userId).toBe("user-1")
  })
})

describe("handleWebhook attributes userId (BIL-092 completion)", () => {
  it("stores the checkout buyer on the event row", async () => {
    await handleWebhook("STRIPE", "{}", {})
    const row = store.events.get("STRIPE:evt-1")
    expect(row?.userId).toBe("user-1")
    expect(mockActivate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    )
  })

  it("resolves the user from the subscription for a renewal event", async () => {
    mockVerify.mockResolvedValue({
      eventId: "evt-2",
      eventType: "invoice.paid",
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: "sub_1",
        periodEnd: null,
      },
    })
    store.subscriptions.set("STRIPE:sub_1", { userId: "user-2" })
    await handleWebhook("STRIPE", "{}", {})
    const row = store.events.get("STRIPE:evt-2")
    expect(row?.userId).toBe("user-2")
    expect(mockExtend).toHaveBeenCalled()
  })

  it("leaves userId null for an ignored event with no identity", async () => {
    mockVerify.mockResolvedValue({
      eventId: "evt-3",
      eventType: "customer.created",
      event: { kind: "ignored" },
    })
    await handleWebhook("STRIPE", "{}", {})
    const row = store.events.get("STRIPE:evt-3")
    expect(row?.userId).toBeNull()
  })

  it("leaves userId null when no subscription matches the provider id", async () => {
    mockVerify.mockResolvedValue({
      eventId: "evt-4",
      eventType: "invoice.paid",
      event: {
        kind: "payment-succeeded",
        providerSubscriptionId: "sub_unknown",
        periodEnd: null,
      },
    })
    await handleWebhook("STRIPE", "{}", {})
    const row = store.events.get("STRIPE:evt-4")
    expect(row?.userId).toBeNull()
  })
})
