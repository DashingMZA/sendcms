// Phase D Worker A — Coupons (plan §3.7, Q6 + Q7 + Q10).
// No test hits the real DB, a real provider, or the network: the
// service tests use the same mocked-Prisma pattern as
// tests/seven-pages-phase-b-worker-b.test.ts.
//
// TIME: no test asserts a locale-rendered clock time. Validation
// uses the real clock (`new Date()` in the service), so seeded
// windows are relative to the real now (past 2026-01-01 / future
// 2027-06-01 around the 2026-11-27 run date); no timeZone pinning
// is needed in an assertion.
//
// DEPENDENCY (coordinator-owned): one repo test fails until the
// coordinator applies the consolidation edit —
// tests/schema-lint.test.ts must add CouponRedemption
// ("append-only log row") to NO_UPDATED_AT_ALLOWLIST, the same
// allowlist SubscriptionEvent / AuditLog / TicketMessage sit in.
// The model is append-only by design (createdAt only, no updatedAt,
// per the task spec), so the lint's "every model has updatedAt"
// assertion flags it until that entry lands. Everything else in
// this file passes without it.
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@sendcms/shared"
import type { AdminSession } from "@sendcms/auth"
import { CouponDiscountType, CouponStatus } from "@sendcms/database"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: "owner-1",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () => makeActor()
const managerActor = () =>
  makeActor({
    id: "mgr-1",
    platformRole: "PLATFORM_USER",
    adminRole: "MANAGER",
  })
const supportActor = () =>
  makeActor({
    id: "sup-1",
    platformRole: "PLATFORM_USER",
    adminRole: "SUPPORT",
  })

const at = (iso: string) => new Date(iso)

// ─── Mocks ────────────────────────────────────────────────────────────

const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))

type StoredCoupon = {
  id: string
  code: string
  name: string | null
  description: string | null
  discountType: string
  discountValue: number
  currency: string
  maxRedemptions: number | null
  redemptionCount: number
  maxRedemptionsPerUser: number | null
  validFrom: Date | null
  validUntil: Date | null
  appliesToPlanIds: string[]
  appliesToBillingInterval: string | null
  firstPurchaseOnly: boolean
  status: string
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}

type StoredRedemption = {
  id: string
  couponId: string
  userId: string
  subscriptionId: string | null
  checkoutAttemptId: string | null
  discountAmount: number
  currency: string
  createdAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    coupons: new Map<string, StoredCoupon>(),
    redemptions: new Map<string, StoredRedemption>(),
    planVersions: new Map<
      string,
      { id: string; planId: string; billingInterval: string }
    >(),
    subscriptions: new Map<
      string,
      { id: string; userId: string; status: string }
    >(),
    purchases: new Map<string, { id: string; userId: string }>(),
    users: new Map<
      string,
      { id: string; name: string | null; email: string }
    >(),
    seq: 1,
  }

  function matchesContains(
    value: string | null,
    cond?: { contains?: string; mode?: string }
  ): boolean {
    if (!cond?.contains) return true
    if (value === null) return false
    const hay = cond.mode === "insensitive" ? value.toLowerCase() : value
    const needle =
      cond.mode === "insensitive" ? cond.contains.toLowerCase() : cond.contains
    return hay.includes(needle)
  }

  function matchesCouponWhere(
    row: StoredCoupon,
    where?: Record<string, unknown>
  ): boolean {
    if (!where) return true
    for (const [key, cond] of Object.entries(where)) {
      if (key === "AND" && Array.isArray(cond)) {
        if (
          !cond.every((c) =>
            matchesCouponWhere(row, c as Record<string, unknown>)
          )
        )
          return false
        continue
      }
      if (key === "OR" && Array.isArray(cond)) {
        if (
          !cond.some((c) =>
            matchesCouponWhere(row, c as Record<string, unknown>)
          )
        )
          return false
        continue
      }
      if (key === "status") {
        if (row.status !== cond) return false
        continue
      }
      if (key === "code" || key === "name") {
        if (
          !matchesContains(
            row[key],
            cond as { contains?: string; mode?: string }
          )
        )
          return false
        continue
      }
      if (key === "validUntil") {
        const c = cond as { lt?: Date }
        if (c.lt && !(row.validUntil !== null && row.validUntil < c.lt))
          return false
        continue
      }
      if (key === "maxRedemptions") {
        const c = cond as { not?: null }
        if (c.not === null && row.maxRedemptions === null) return false
        continue
      }
    }
    return true
  }

  function sortByCreatedAt<T extends { createdAt: Date }>(
    rows: T[],
    order?: { createdAt?: "asc" | "desc" }
  ): T[] {
    if (!order?.createdAt) return rows
    const dir = order.createdAt === "desc" ? -1 : 1
    return [...rows].sort(
      (a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime())
    )
  }

  function paged<T>(rows: T[], skip = 0, take?: number): T[] {
    return take === undefined ? rows.slice(skip) : rows.slice(skip, skip + take)
  }

  const mockDb = {
    coupon: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; code?: string } }) => {
          if (where.id) return store.coupons.get(where.id) ?? null
          if (where.code) {
            return (
              [...store.coupons.values()].find((c) => c.code === where.code) ??
              null
            )
          }
          return null
        }
      ),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          skip = 0,
          take,
        }: {
          where?: Record<string, unknown>
          orderBy?: { createdAt?: "asc" | "desc" }
          skip?: number
          take?: number
        }) =>
          paged(
            sortByCreatedAt(
              [...store.coupons.values()].filter((c) =>
                matchesCouponWhere(c, where)
              ),
              orderBy
            ),
            skip,
            take
          )
      ),
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        return [...store.coupons.values()].filter((c) =>
          matchesCouponWhere(c, where)
        ).length
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if ([...store.coupons.values()].some((c) => c.code === data.code)) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          })
        }
        const id = `cp-${store.seq++}`
        const row: StoredCoupon = {
          id,
          code: data.code as string,
          name: (data.name as string | null) ?? null,
          description: (data.description as string | null) ?? null,
          discountType: data.discountType as string,
          discountValue: data.discountValue as number,
          currency: (data.currency as string) ?? "USD",
          maxRedemptions: (data.maxRedemptions as number | null) ?? null,
          redemptionCount: 0,
          maxRedemptionsPerUser:
            (data.maxRedemptionsPerUser as number | null) ?? null,
          validFrom: (data.validFrom as Date | null) ?? null,
          validUntil: (data.validUntil as Date | null) ?? null,
          appliesToPlanIds: (data.appliesToPlanIds as string[]) ?? [],
          appliesToBillingInterval:
            (data.appliesToBillingInterval as string | null) ?? null,
          firstPurchaseOnly: (data.firstPurchaseOnly as boolean) ?? false,
          status: (data.status as string) ?? "ACTIVE",
          createdById: (data.createdById as string | null) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        store.coupons.set(id, row)
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
          const row = store.coupons.get(where.id)
          if (!row) throw new Error("Record not found")
          Object.assign(row, data, { updatedAt: new Date() })
          return row
        }
      ),
    },
    couponRedemption: {
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        const w = (where ?? {}) as { couponId?: string; userId?: string }
        return [...store.redemptions.values()].filter(
          (r) =>
            (w.couponId === undefined || r.couponId === w.couponId) &&
            (w.userId === undefined || r.userId === w.userId)
        ).length
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `cr-${store.seq++}`
        const row: StoredRedemption = {
          id,
          couponId: data.couponId as string,
          userId: data.userId as string,
          subscriptionId: (data.subscriptionId as string | null) ?? null,
          checkoutAttemptId: (data.checkoutAttemptId as string | null) ?? null,
          discountAmount: data.discountAmount as number,
          currency: (data.currency as string) ?? "USD",
          createdAt: new Date(),
        }
        store.redemptions.set(id, row)
        return row
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          skip = 0,
          take,
        }: {
          where?: { couponId?: string }
          orderBy?: { createdAt?: "asc" | "desc" }
          skip?: number
          take?: number
        }) => {
          const rows = paged(
            sortByCreatedAt(
              [...store.redemptions.values()].filter(
                (r) =>
                  where?.couponId === undefined || r.couponId === where.couponId
              ),
              orderBy
            ),
            skip,
            take
          )
          return rows.map((r) => ({
            ...r,
            user: store.users.get(r.userId) ?? { name: null, email: "" },
          }))
        }
      ),
    },
    planVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.planVersions.get(where.id) ?? null
      }),
    },
    subscription: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where?: { userId?: string; status?: { in?: string[] } }
        }) => {
          return (
            [...store.subscriptions.values()].find(
              (s) =>
                (where?.userId === undefined || s.userId === where.userId) &&
                (where?.status?.in === undefined ||
                  where.status.in.includes(s.status))
            ) ?? null
          )
        }
      ),
    },
    oneTimePurchase: {
      findFirst: vi.fn(async ({ where }: { where?: { userId?: string } }) => {
        return (
          [...store.purchases.values()].find(
            (p) => where?.userId === undefined || p.userId === where.userId
          ) ?? null
        )
      }),
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

// The service under test, imported through its source path.
import {
  createCoupon,
  deleteCoupon,
  disableCoupon,
  getCoupon,
  getCouponByCode,
  listCouponRedemptions,
  listCoupons,
  recordRedemption,
  updateCoupon,
  validateCouponForCheckout,
} from "../packages/modules/coupons/src/service"
import {
  CouponsQuerySchema,
  CouponDiscountTypeSchema,
  CouponStatusSchema,
  CreateCouponSchema,
} from "../packages/modules/coupons/src/validators"

// ─── Seed helpers ─────────────────────────────────────────────────────

function seedCoupon(overrides: Partial<StoredCoupon> = {}) {
  const id = overrides.id ?? `cp-${store.seq++}`
  const row: StoredCoupon = {
    id,
    code: "WELCOME10",
    name: null,
    description: null,
    discountType: "PERCENT",
    discountValue: 10,
    currency: "USD",
    maxRedemptions: null,
    redemptionCount: 0,
    maxRedemptionsPerUser: null,
    validFrom: null,
    validUntil: null,
    appliesToPlanIds: [],
    appliesToBillingInterval: null,
    firstPurchaseOnly: false,
    status: "ACTIVE",
    createdById: "owner-1",
    createdAt: at("2026-11-01T00:00:00Z"),
    updatedAt: at("2026-11-01T00:00:00Z"),
    ...overrides,
  }
  store.coupons.set(id, row)
  return row
}

function seedRedemption(overrides: Partial<StoredRedemption> = {}) {
  const id = overrides.id ?? `cr-${store.seq++}`
  const row: StoredRedemption = {
    id,
    couponId: "cp-1",
    userId: "user-1",
    subscriptionId: null,
    checkoutAttemptId: null,
    discountAmount: 199,
    currency: "USD",
    createdAt: at("2026-11-26T10:00:00Z"),
    ...overrides,
  }
  store.redemptions.set(id, row)
  return row
}

function seedPlanVersion(
  id: string,
  planId = "plan-1",
  billingInterval = "MONTHLY"
) {
  store.planVersions.set(id, { id, planId, billingInterval })
  return id
}

function seedSubscription(userId: string, status = "ACTIVE") {
  const id = `sub-${store.seq++}`
  store.subscriptions.set(id, { id, userId, status })
  return id
}

function seedPurchase(userId: string) {
  const id = `otp-${store.seq++}`
  store.purchases.set(id, { id, userId })
  return id
}

const validateInput = (overrides: Record<string, unknown> = {}) => ({
  code: "WELCOME10",
  userId: "user-1",
  planVersionId: "pv-1",
  priceAmountMinor: 1999,
  currency: "USD",
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  store.coupons.clear()
  store.redemptions.clear()
  store.planVersions.clear()
  store.subscriptions.clear()
  store.purchases.clear()
  store.users.clear()
  store.seq = 1
  store.users.set("user-1", {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
  })
  store.users.set("user-2", {
    id: "user-2",
    name: "Bob",
    email: "bob@example.com",
  })
  seedPlanVersion("pv-1", "plan-1", "MONTHLY")
  seedPlanVersion("pv-2", "plan-2", "ANNUAL")
})

// ─── validateCouponForCheckout — validation matrix ─────────────────────

describe("validateCouponForCheckout — validation matrix", () => {
  it("validates a plain PERCENT code and returns the discount", async () => {
    seedCoupon({ id: "cp-1" })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
    expect(result.finalAmountMinor).toBe(1800)
    expect(result.currency).toBe("USD")
    expect(result.coupon.code).toBe("WELCOME10")
  })

  it("normalises the code (trim + upper-case) before lookup", async () => {
    seedCoupon({ id: "cp-1" })
    const result = await validateCouponForCheckout(
      validateInput({ code: "  welcome10 " })
    )
    expect(result.coupon.code).toBe("WELCOME10")
  })

  it("rejects a code with an internal space", async () => {
    seedCoupon({ id: "cp-1" })
    await expect(
      validateCouponForCheckout(validateInput({ code: "WELCOME 10" }))
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon code is not valid.",
    })
  })

  it("rejects an unknown code with the customer-safe message", async () => {
    await expect(
      validateCouponForCheckout(validateInput({ code: "NOPE" }))
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon code is not valid.",
    })
  })

  it("rejects a DISABLED code", async () => {
    seedCoupon({ id: "cp-1", status: "DISABLED" })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
    })
  })

  it("rejects a code whose window has not opened yet", async () => {
    seedCoupon({ id: "cp-1", validFrom: at("2027-06-01T00:00:00Z") })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon is not valid yet.",
    })
  })

  it("rejects an expired code (validUntil in the past)", async () => {
    seedCoupon({ id: "cp-1", validUntil: at("2026-01-01T00:00:00Z") })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon has expired.",
    })
  })

  it("rejects a code whose redemption cap is exhausted", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: 2, redemptionCount: 2 })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon has reached its redemption limit.",
    })
  })

  it("accepts a code one redemption below its cap", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: 2, redemptionCount: 1 })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
  })

  it("rejects when the user already hit the per-user cap", async () => {
    seedCoupon({ id: "cp-1", maxRedemptionsPerUser: 1 })
    seedRedemption({ couponId: "cp-1", userId: "user-1" })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
    })
  })

  it("counts the per-user cap per user, not globally", async () => {
    seedCoupon({ id: "cp-1", maxRedemptionsPerUser: 1 })
    seedRedemption({ couponId: "cp-1", userId: "user-2" })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
  })

  it("rejects a code scoped to a different plan", async () => {
    seedCoupon({ id: "cp-1", appliesToPlanIds: ["plan-2"] })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon does not apply to this plan.",
    })
  })

  it("accepts a code scoped to the plan being bought", async () => {
    seedCoupon({ id: "cp-1", appliesToPlanIds: ["plan-1"] })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
  })

  it("rejects a code scoped to a different billing interval", async () => {
    seedCoupon({ id: "cp-1", appliesToBillingInterval: "ANNUAL" })
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon does not apply to this billing interval.",
    })
  })

  it("accepts a code scoped to the matching billing interval", async () => {
    seedCoupon({ id: "cp-1", appliesToBillingInterval: "MONTHLY" })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
  })

  it("rejects firstPurchaseOnly when the user has a live subscription", async () => {
    seedCoupon({ id: "cp-1", firstPurchaseOnly: true })
    seedSubscription("user-1", "ACTIVE")
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon is only valid for your first purchase.",
    })
  })

  it("rejects firstPurchaseOnly when the user has a TRIALING subscription", async () => {
    seedCoupon({ id: "cp-1", firstPurchaseOnly: true })
    seedSubscription("user-1", "TRIALING")
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
    })
  })

  it("rejects firstPurchaseOnly when the user has a prior one-time purchase", async () => {
    seedCoupon({ id: "cp-1", firstPurchaseOnly: true })
    seedPurchase("user-1")
    await expect(
      validateCouponForCheckout(validateInput())
    ).rejects.toMatchObject({
      status: 422,
    })
  })

  it("accepts firstPurchaseOnly when the user's only subscription is CANCELED", async () => {
    seedCoupon({ id: "cp-1", firstPurchaseOnly: true })
    seedSubscription("user-1", "CANCELED")
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(199)
  })

  it("floors the PERCENT discount (1999 x 10% = 199, not 200)", async () => {
    seedCoupon({ id: "cp-1", discountValue: 10 })
    const result = await validateCouponForCheckout(
      validateInput({ priceAmountMinor: 1999 })
    )
    expect(result.discountAmountMinor).toBe(199)
    expect(result.finalAmountMinor).toBe(1800)
  })

  it("caps a 100% PERCENT discount at the price (final 0, never negative)", async () => {
    seedCoupon({ id: "cp-1", discountValue: 100 })
    const result = await validateCouponForCheckout(
      validateInput({ priceAmountMinor: 500 })
    )
    expect(result.discountAmountMinor).toBe(500)
    expect(result.finalAmountMinor).toBe(0)
  })

  it("applies a FIXED discount in minor units", async () => {
    seedCoupon({
      id: "cp-1",
      discountType: "FIXED",
      discountValue: 500,
      currency: "USD",
    })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(500)
    expect(result.finalAmountMinor).toBe(1499)
    expect(result.currency).toBe("USD")
  })

  it("caps a FIXED discount at the price with min(value, price)", async () => {
    seedCoupon({
      id: "cp-1",
      discountType: "FIXED",
      discountValue: 5000,
      currency: "USD",
    })
    const result = await validateCouponForCheckout(validateInput())
    expect(result.discountAmountMinor).toBe(1999)
    expect(result.finalAmountMinor).toBe(0)
  })

  it("rejects a FIXED coupon whose currency mismatches the price", async () => {
    seedCoupon({
      id: "cp-1",
      discountType: "FIXED",
      discountValue: 500,
      currency: "EUR",
    })
    await expect(
      validateCouponForCheckout(validateInput({ currency: "USD" }))
    ).rejects.toMatchObject({
      status: 422,
      message: "This coupon is not valid for this currency.",
    })
  })

  it("lets a PERCENT coupon use the price currency, not its own", async () => {
    seedCoupon({ id: "cp-1", currency: "EUR" })
    const result = await validateCouponForCheckout(
      validateInput({ currency: "USD" })
    )
    expect(result.discountAmountMinor).toBe(199)
    expect(result.currency).toBe("USD")
  })

  it("404s when the plan version is unknown", async () => {
    seedCoupon({ id: "cp-1" })
    await expect(
      validateCouponForCheckout(validateInput({ planVersionId: "pv-nope" }))
    ).rejects.toMatchObject({ status: 404 })
  })
})

// ─── createCoupon ─────────────────────────────────────────────────────

describe("createCoupon", () => {
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    code: "SAVE20",
    discountType: "PERCENT" as const,
    discountValue: 20,
    ...overrides,
  })

  it("creates a coupon, normalised to upper-case, and audits CREATE on COUPON", async () => {
    const created = await createCoupon(ownerActor(), createInput())
    expect(created.code).toBe("SAVE20")
    expect(created.status).toBe("ACTIVE")
    expect(created.redemptionCount).toBe(0)
    expect(created.createdById).toBe("owner-1")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: "COUPON",
        resourceId: created.id,
        detail: expect.objectContaining({
          event: "coupon-created",
          code: "SAVE20",
        }),
      })
    )
  })

  it("normalises a lower-case code to upper-case", async () => {
    const created = await createCoupon(
      ownerActor(),
      createInput({ code: "save20" })
    )
    expect(created.code).toBe("SAVE20")
    expect(store.coupons.get(created.id)?.code).toBe("SAVE20")
  })

  it("rejects a PERCENT value of 0 and of 101 with 422", async () => {
    await expect(
      createCoupon(ownerActor(), createInput({ discountValue: 0 }))
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      createCoupon(ownerActor(), createInput({ discountValue: 101 }))
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects a non-positive FIXED value with 422", async () => {
    await expect(
      createCoupon(
        ownerActor(),
        createInput({ discountType: "FIXED", discountValue: 0 })
      )
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects a code containing spaces with 422", async () => {
    await expect(
      createCoupon(ownerActor(), createInput({ code: "SAVE 20" }))
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects validUntil at or before validFrom with 422", async () => {
    await expect(
      createCoupon(
        ownerActor(),
        createInput({
          validFrom: "2026-06-01T00:00:00Z",
          validUntil: "2026-06-01T00:00:00Z",
        })
      )
    ).rejects.toMatchObject({ status: 422 })
  })

  it("rejects a duplicate code with 409 (case-insensitive match)", async () => {
    seedCoupon({ id: "cp-1", code: "SAVE20" })
    await expect(
      createCoupon(ownerActor(), createInput({ code: "save20" }))
    ).rejects.toMatchObject({
      status: 409,
      message: "A coupon with this code already exists.",
    })
  })

  it("refuses MANAGER (Q10: owner + SUPER_ADMIN only)", async () => {
    await expect(
      createCoupon(managerActor(), createInput())
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.coupon.create).not.toHaveBeenCalled()
  })

  it("refuses SUPPORT", async () => {
    await expect(
      createCoupon(supportActor(), createInput())
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ─── disableCoupon / deleteCoupon (soft) ───────────────────────────────

describe("disableCoupon / deleteCoupon — soft only", () => {
  it("disables a coupon and audits UPDATE on COUPON", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    const updated = await disableCoupon(ownerActor(), coupon.id)
    expect(updated.status).toBe("DISABLED")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "COUPON",
        resourceId: coupon.id,
        detail: expect.objectContaining({ event: "coupon-disabled" }),
      })
    )
  })

  it("404s for an unknown coupon on disable", async () => {
    await expect(disableCoupon(ownerActor(), "cp-nope")).rejects.toMatchObject({
      status: 404,
    })
  })

  it("refuses MANAGER on disable (Q10)", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    await expect(
      disableCoupon(managerActor(), coupon.id)
    ).rejects.toMatchObject({ status: 403 })
    expect(store.coupons.get(coupon.id)?.status).toBe("ACTIVE")
  })

  it("soft-deletes: status flips to DISABLED, redemptions untouched, audit DELETE", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    seedRedemption({ couponId: "cp-1", userId: "user-1" })
    seedRedemption({ couponId: "cp-1", userId: "user-2" })
    const updated = await deleteCoupon(ownerActor(), coupon.id)
    expect(updated.status).toBe("DISABLED")
    expect(store.coupons.has(coupon.id)).toBe(true)
    expect(
      [...store.redemptions.values()].filter((r) => r.couponId === "cp-1")
    ).toHaveLength(2)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DELETE",
        resourceType: "COUPON",
        resourceId: coupon.id,
        detail: expect.objectContaining({
          event: "coupon-deleted",
          soft: true,
        }),
      })
    )
  })

  it("404s for an unknown coupon on delete", async () => {
    await expect(deleteCoupon(ownerActor(), "cp-nope")).rejects.toMatchObject({
      status: 404,
    })
  })

  it("refuses MANAGER on delete (Q10)", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    await expect(deleteCoupon(managerActor(), coupon.id)).rejects.toMatchObject(
      {
        status: 403,
      }
    )
    expect(store.coupons.get(coupon.id)?.status).toBe("ACTIVE")
  })
})

describe("getCouponByCode — read-only lookup (consolidation)", () => {
  it("resolves the coupon id for a code, normalised to upper-case", async () => {
    seedCoupon({ id: "cp-1", code: "WELCOME10" })
    const found = await getCouponByCode(mockDb as never, "welcome10")
    expect(found?.id).toBe("cp-1")
    expect(found?.code).toBe("WELCOME10")
  })

  it("returns null for an unknown code", async () => {
    const found = await getCouponByCode(mockDb as never, "NOPE")
    expect(found).toBeNull()
  })

  it("does NOT validate: a DISABLED or expired coupon still resolves", async () => {
    // That is the point of the lookup — the grant path must not
    // re-run business rules on a code that was valid at checkout.
    seedCoupon({
      id: "cp-1",
      code: "OLD10",
      status: "DISABLED",
      validUntil: at("2026-01-01T00:00:00Z"),
    })
    const found = await getCouponByCode(mockDb as never, "OLD10")
    expect(found?.id).toBe("cp-1")
    expect(found?.status).toBe("DISABLED")
  })
})

describe("updateCoupon — field edits + re-enable (consolidation)", () => {
  it("edits mutable fields and audits UPDATE on COUPON", async () => {
    const coupon = seedCoupon({ id: "cp-1", maxRedemptions: 5 })
    const updated = await updateCoupon(ownerActor(), coupon.id, {
      name: "Black Friday",
      maxRedemptions: 10,
      validUntil: new Date("2027-06-01T00:00:00Z"),
    })
    expect(updated.name).toBe("Black Friday")
    expect(updated.maxRedemptions).toBe(10)
    expect(updated.code).toBe("WELCOME10")
    expect(updated.discountValue).toBe(10)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "COUPON",
        resourceId: coupon.id,
        detail: expect.objectContaining({ event: "coupon-updated" }),
      })
    )
  })

  it("re-enables a DISABLED coupon", async () => {
    const coupon = seedCoupon({ id: "cp-1", status: "DISABLED" })
    const updated = await updateCoupon(ownerActor(), coupon.id, {
      status: "ACTIVE",
    })
    expect(updated.status).toBe("ACTIVE")
  })

  it("clears a field sent as null and leaves omitted fields alone", async () => {
    const coupon = seedCoupon({
      id: "cp-1",
      name: "Old name",
      description: "Keep me",
    })
    const updated = await updateCoupon(ownerActor(), coupon.id, {
      name: null,
    })
    expect(updated.name).toBeNull()
    expect(updated.description).toBe("Keep me")
  })

  it("422s on the immutable deal fields (code / discountType / discountValue / currency)", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    for (const body of [
      { code: "NEWCODE" },
      { discountType: "FIXED" },
      { discountValue: 50 },
      { currency: "EUR" },
    ]) {
      // Deliberately invalid shapes: the strict schema must 422
      // them at runtime, so the cast bypasses the input type.
      await expect(
        updateCoupon(ownerActor(), coupon.id, body as never)
      ).rejects.toMatchObject({ status: 422 })
    }
    expect(store.coupons.get(coupon.id)?.code).toBe("WELCOME10")
  })

  it("422s on an empty body", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    await expect(
      updateCoupon(ownerActor(), coupon.id, {})
    ).rejects.toMatchObject({ status: 422 })
  })

  it("422s when the cap drops below redemptions already recorded", async () => {
    const coupon = seedCoupon({
      id: "cp-1",
      maxRedemptions: 5,
      redemptionCount: 3,
    })
    await expect(
      updateCoupon(ownerActor(), coupon.id, { maxRedemptions: 2 })
    ).rejects.toMatchObject({ status: 422 })
    expect(store.coupons.get(coupon.id)?.maxRedemptions).toBe(5)
  })

  it("422s when the merged window goes invalid (new validFrom past stored validUntil)", async () => {
    const coupon = seedCoupon({
      id: "cp-1",
      validUntil: at("2026-06-01T00:00:00Z"),
    })
    await expect(
      updateCoupon(ownerActor(), coupon.id, {
        validFrom: at("2026-07-01T00:00:00Z"),
      })
    ).rejects.toMatchObject({ status: 422 })
  })

  it("404s for an unknown coupon", async () => {
    await expect(
      updateCoupon(ownerActor(), "cp-nope", { name: "x" })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("refuses MANAGER on update (Q10)", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    await expect(
      updateCoupon(managerActor(), coupon.id, { name: "x" })
    ).rejects.toMatchObject({ status: 403 })
    expect(store.coupons.get(coupon.id)?.name).toBeNull()
  })
})

// ─── listCoupons / getCoupon ────────────────────────────────────────────

describe("listCoupons / getCoupon", () => {
  it("paginates newest-first with totalPages", async () => {
    seedCoupon({ id: "cp-1", createdAt: at("2026-11-01T00:00:00Z") })
    seedCoupon({
      id: "cp-2",
      code: "SAVE20",
      createdAt: at("2026-11-02T00:00:00Z"),
    })
    seedCoupon({
      id: "cp-3",
      code: "HALF",
      createdAt: at("2026-11-03T00:00:00Z"),
    })
    const page = await listCoupons(ownerActor(), { page: 1, perPage: 2 })
    expect(page.total).toBe(3)
    expect(page.totalPages).toBe(2)
    expect(page.coupons.map((c) => c.id)).toEqual(["cp-3", "cp-2"])
    const page2 = await listCoupons(ownerActor(), { page: 2, perPage: 2 })
    expect(page2.coupons.map((c) => c.id)).toEqual(["cp-1"])
  })

  it("filters by stored status", async () => {
    seedCoupon({ id: "cp-1" })
    seedCoupon({ id: "cp-2", code: "SAVE20", status: "DISABLED" })
    const active = await listCoupons(ownerActor(), { status: "ACTIVE" })
    expect(active.total).toBe(1)
    expect(active.coupons[0].id).toBe("cp-1")
    const disabled = await listCoupons(ownerActor(), { status: "DISABLED" })
    expect(disabled.total).toBe(1)
    expect(disabled.coupons[0].id).toBe("cp-2")
  })

  it("Active excludes derived-expired codes (consolidation live find)", async () => {
    // Stored ACTIVE but lapsed by window (cp-1) or by reached cap
    // (cp-2) must NOT appear under Active — they belong under
    // Expired only. A live code (cp-3) stays; DISABLED (cp-4)
    // stays under Disabled.
    seedCoupon({ id: "cp-1", validUntil: at("2026-01-01T00:00:00Z") })
    seedCoupon({
      id: "cp-2",
      code: "ONEUSE",
      maxRedemptions: 1,
      redemptionCount: 1,
    })
    seedCoupon({
      id: "cp-3",
      code: "LIVE",
      validUntil: at("2027-06-01T00:00:00Z"),
    })
    seedCoupon({
      id: "cp-4",
      code: "OFF",
      status: "DISABLED",
      validUntil: at("2027-06-01T00:00:00Z"),
    })
    const active = await listCoupons(ownerActor(), { status: "ACTIVE" })
    expect(active.total).toBe(1)
    expect(active.coupons[0].id).toBe("cp-3")
    const expired = await listCoupons(ownerActor(), { status: "EXPIRED" })
    expect(expired.total).toBe(2)
    expect(expired.coupons.map((c) => c.id).sort()).toEqual(["cp-1", "cp-2"])
  })

  it("Expired matches past validUntil OR a reached cap — and nothing else", async () => {
    seedCoupon({ id: "cp-1", validUntil: at("2026-01-01T00:00:00Z") })
    seedCoupon({
      id: "cp-2",
      code: "ONEUSE",
      maxRedemptions: 1,
      redemptionCount: 1,
    })
    seedCoupon({
      id: "cp-3",
      code: "LIVE",
      validUntil: at("2027-06-01T00:00:00Z"),
    })
    seedCoupon({
      id: "cp-4",
      code: "OFF",
      status: "DISABLED",
      validUntil: at("2027-06-01T00:00:00Z"),
    })
    const expired = await listCoupons(ownerActor(), { status: "EXPIRED" })
    expect(expired.total).toBe(2)
    expect(expired.coupons.map((c) => c.id).sort()).toEqual(["cp-1", "cp-2"])
  })

  it("searches code and name case-insensitively", async () => {
    seedCoupon({ id: "cp-1", name: "Welcome offer" })
    seedCoupon({ id: "cp-2", code: "SAVE20", name: "Spring sale" })
    const byCode = await listCoupons(ownerActor(), { search: "welcome10" })
    expect(byCode.total).toBe(1)
    expect(byCode.coupons[0].id).toBe("cp-1")
    const byName = await listCoupons(ownerActor(), { search: "spring" })
    expect(byName.total).toBe(1)
    expect(byName.coupons[0].id).toBe("cp-2")
  })

  it("refuses SUPPORT the list (no VIEW_BILLING)", async () => {
    seedCoupon({ id: "cp-1" })
    await expect(listCoupons(supportActor(), {})).rejects.toMatchObject({
      status: 403,
    })
    expect(mockDb.coupon.count).not.toHaveBeenCalled()
  })

  it("lets MANAGER read the list (VIEW_BILLING)", async () => {
    seedCoupon({ id: "cp-1" })
    const page = await listCoupons(managerActor(), {})
    expect(page.total).toBe(1)
  })

  it("gets one coupon and 404s when unknown", async () => {
    const coupon = seedCoupon({ id: "cp-1" })
    const found = await getCoupon(ownerActor(), coupon.id)
    expect(found.code).toBe("WELCOME10")
    await expect(getCoupon(ownerActor(), "cp-nope")).rejects.toMatchObject({
      status: 404,
    })
  })
})

// ─── listCouponRedemptions ──────────────────────────────────────────────

describe("listCouponRedemptions", () => {
  it("returns rows with the redeeming user's name + email, newest first", async () => {
    seedCoupon({ id: "cp-1" })
    seedRedemption({
      couponId: "cp-1",
      userId: "user-1",
      subscriptionId: "sub-1",
      checkoutAttemptId: "att-1",
      discountAmount: 199,
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedRedemption({
      couponId: "cp-1",
      userId: "user-2",
      discountAmount: 199,
      createdAt: at("2026-11-25T10:00:00Z"),
    })
    const page = await listCouponRedemptions(ownerActor(), "cp-1", {})
    expect(page.total).toBe(2)
    expect(page.redemptions[0].userName).toBe("Alice")
    expect(page.redemptions[0].userEmail).toBe("alice@example.com")
    expect(page.redemptions[0].subscriptionId).toBe("sub-1")
    expect(page.redemptions[0].checkoutAttemptId).toBe("att-1")
    expect(page.redemptions[1].userName).toBe("Bob")
  })

  it("404s when the coupon is unknown", async () => {
    await expect(
      listCouponRedemptions(ownerActor(), "cp-nope", {})
    ).rejects.toMatchObject({ status: 404 })
  })

  it("refuses SUPPORT (no VIEW_BILLING)", async () => {
    seedCoupon({ id: "cp-1" })
    await expect(
      listCouponRedemptions(supportActor(), "cp-1", {})
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ─── recordRedemption ───────────────────────────────────────────────────

describe("recordRedemption — atomic increment (Wave 1 pattern)", () => {
  // A transaction client over the mock store: create appends the
  // redemption row; updateMany applies the conditional increment
  // (redemptionCount < maxRedemptions) and reports the matched count.
  function makeTx() {
    return {
      coupon: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = store.coupons.get(where.id) ?? null
          return row ? { id: row.id, maxRedemptions: row.maxRedemptions } : null
        }),
        updateMany: vi.fn(
          async ({
            where,
          }: {
            where: { id: string; redemptionCount?: { lt?: number } }
          }) => {
            const row = store.coupons.get(where.id)
            if (!row) return { count: 0 }
            if (
              where.redemptionCount?.lt !== undefined &&
              row.redemptionCount >= where.redemptionCount.lt
            ) {
              return { count: 0 }
            }
            row.redemptionCount += 1
            return { count: 1 }
          }
        ),
      },
      couponRedemption: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const id = `cr-${store.seq++}`
          const row: StoredRedemption = {
            id,
            couponId: data.couponId as string,
            userId: data.userId as string,
            subscriptionId: (data.subscriptionId as string | null) ?? null,
            checkoutAttemptId:
              (data.checkoutAttemptId as string | null) ?? null,
            discountAmount: data.discountAmount as number,
            currency: (data.currency as string) ?? "USD",
            createdAt: new Date(),
          }
          store.redemptions.set(id, row)
          return row
        }),
      },
    }
  }

  it("inserts the redemption row and increments the count by exactly one", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: 5, redemptionCount: 2 })
    const tx = makeTx()
    await recordRedemption(tx as never, {
      couponId: "cp-1",
      userId: "user-1",
      subscriptionId: "sub-1",
      checkoutAttemptId: "att-1",
      discountAmountMinor: 199,
      currency: "USD",
    })
    expect(store.coupons.get("cp-1")?.redemptionCount).toBe(3)
    const rows = [...store.redemptions.values()].filter(
      (r) => r.couponId === "cp-1"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].discountAmount).toBe(199)
    expect(rows[0].subscriptionId).toBe("sub-1")
    expect(rows[0].checkoutAttemptId).toBe("att-1")
  })

  it("increments unconditionally when maxRedemptions is null", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: null, redemptionCount: 41 })
    const tx = makeTx()
    await recordRedemption(tx as never, {
      couponId: "cp-1",
      userId: "user-1",
      discountAmountMinor: 199,
      currency: "USD",
    })
    expect(store.coupons.get("cp-1")?.redemptionCount).toBe(42)
  })

  it("throws 409 when the cap was reached between validation and grant", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: 1, redemptionCount: 1 })
    const tx = makeTx()
    await expect(
      recordRedemption(tx as never, {
        couponId: "cp-1",
        userId: "user-1",
        discountAmountMinor: 199,
        currency: "USD",
      })
    ).rejects.toMatchObject({
      status: 409,
      message: "This coupon has reached its redemption limit.",
    })
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "COUPON",
        resourceId: "cp-1",
        detail: expect.objectContaining({
          event: "coupon-redemption-rejected",
        }),
      })
    )
  })

  it("404s for an unknown coupon", async () => {
    const tx = makeTx()
    await expect(
      recordRedemption(tx as never, {
        couponId: "cp-nope",
        userId: "user-1",
        discountAmountMinor: 199,
        currency: "USD",
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("concurrency: two parallel redemptions against maxRedemptions 1 — exactly one succeeds", async () => {
    seedCoupon({ id: "cp-1", maxRedemptions: 1, redemptionCount: 0 })
    // The conditional updateMany is the arbiter: the first caller
    // matches (count 1), the second finds the cap reached (count 0).
    let calls = 0
    const racingTx = () => ({
      coupon: {
        findUnique: vi.fn(async () => ({
          id: "cp-1",
          maxRedemptions: 1,
        })),
        updateMany: vi.fn(async () => ({ count: ++calls === 1 ? 1 : 0 })),
      },
      couponRedemption: {
        create: vi.fn(async () => ({ id: `cr-${calls}` })),
      },
    })
    const results = await Promise.allSettled([
      recordRedemption(racingTx() as never, {
        couponId: "cp-1",
        userId: "user-1",
        discountAmountMinor: 199,
        currency: "USD",
      }),
      recordRedemption(racingTx() as never, {
        couponId: "cp-1",
        userId: "user-2",
        discountAmountMinor: 199,
        currency: "USD",
      }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    })
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ApiError
    )
  })
})

// ─── Validators ────────────────────────────────────────────────────────

describe("Coupons validators", () => {
  it("defaults the list query to page 1, 20 per page, status all", () => {
    expect(CouponsQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
      status: "all",
    })
  })

  it("rejects an unknown list status", () => {
    expect(CouponsQuerySchema.safeParse({ status: "bogus" }).success).toBe(
      false
    )
  })

  it("normalises the create code to upper-case and defaults currency + flags", () => {
    const parsed = CreateCouponSchema.parse({
      code: "save20",
      discountType: "PERCENT",
      discountValue: 20,
    })
    expect(parsed.code).toBe("SAVE20")
    expect(parsed.currency).toBe("USD")
    expect(parsed.appliesToPlanIds).toEqual([])
    expect(parsed.firstPurchaseOnly).toBe(false)
  })

  it("rejects a PERCENT value outside 1–100 and a FIXED value of 0", () => {
    expect(
      CreateCouponSchema.safeParse({
        code: "SAVE1",
        discountType: "PERCENT",
        discountValue: 0,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "SAVE1",
        discountType: "PERCENT",
        discountValue: 101,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "SAVE1",
        discountType: "FIXED",
        discountValue: 0,
      }).success
    ).toBe(false)
    expect(
      CreateCouponSchema.safeParse({
        code: "SAVE1",
        discountType: "FIXED",
        discountValue: 500,
      }).success
    ).toBe(true)
  })

  it("rejects a code with spaces", () => {
    expect(
      CreateCouponSchema.safeParse({
        code: "SAVE 20",
        discountType: "PERCENT",
        discountValue: 20,
      }).success
    ).toBe(false)
  })
})

// ─── Enum drift guard + bundle boundary ─────────────────────────────────

describe("Coupons — enum drift guard + bundle boundary", () => {
  it("the local Zod enums match the Prisma enums exactly", () => {
    expect(Object.keys(CouponDiscountType).sort()).toEqual(["FIXED", "PERCENT"])
    expect(Object.keys(CouponStatus).sort()).toEqual([
      "ACTIVE",
      "DISABLED",
      "EXPIRED",
    ])
    expect([...CouponDiscountTypeSchema.options].sort()).toEqual(
      Object.keys(CouponDiscountType).sort()
    )
    expect([...CouponStatusSchema.options].sort()).toEqual(
      Object.keys(CouponStatus).sort()
    )
  })

  it("the schema carries the Coupon models + AuditResource.COUPON + checkout columns", () => {
    const schema = read("packages/database/prisma/schema.prisma")
    expect(schema).toContain("model Coupon {")
    expect(schema).toContain("model CouponRedemption {")
    expect(schema).toContain("COUPON")
    expect(schema).toContain("couponCode         String?")
    expect(schema).toContain("discountAmountMinor Int?")
    expect(schema).toContain("enum CouponDiscountType {")
    expect(schema).toContain("enum CouponStatus {")
    // No unique that would forbid a legitimate second redemption:
    // first-purchase-only is the rule, not a unique constraint.
    expect(schema).not.toContain("@@unique([couponId, userId, subscriptionId])")
  })

  it("queries.ts uses only apiFetch — no db import in client code", () => {
    const src = read("packages/modules/coupons/src/queries.ts")
    expect(src).toContain("apiFetch")
    expect(src).not.toContain("@sendcms/database")
    expect(src).not.toContain('from "@sendcms/coupons"')
    // Type-only imports from ./service are the boundary (same as
    // @sendcms/billing/queries); a VALUE import would pull the
    // service — and through it the database client — into the
    // browser bundle.
    expect(src).toContain("import type {")
    expect(src).not.toMatch(/^import \{[^}]*\} from "\.\/service"/m)
  })

  it("the service stays in the layered flow: no Next.js imports", () => {
    const src = read("packages/modules/coupons/src/service.ts")
    expect(src).not.toContain("next/")
    expect(src).not.toContain("revalidatePath")
  })
})
