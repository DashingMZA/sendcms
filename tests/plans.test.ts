// Plans & entitlements service gates (Phase 4) with a mocked Prisma
// client. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@sendcms/database"

const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))

const mockDb = vi.hoisted(() => ({
  plan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  planVersion: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  subscription: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  subscriptionEvent: { create: vi.fn(), findMany: vi.fn() },
  usageLedger: { create: vi.fn(), findUnique: vi.fn(), aggregate: vi.fn() },
  entitlementOverride: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  form: { count: vi.fn(), findMany: vi.fn() },
  domain: { count: vi.fn() },
  apiKey: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  submission: { count: vi.fn() },
  aiDailyUsage: { aggregate: vi.fn() },
  apiKeyRateLimit: { aggregate: vi.fn() },
  // Array form: the array already holds the mock calls' promises.
  // Callback form: run it against mockDb (tx IS mockDb).
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof mockDb) => unknown)(mockDb)
    }
    if (Array.isArray(arg)) return Promise.all(arg)
    return arg
  }),
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit }
})

import type { AdminSession } from "@sendcms/auth"
import {
  archivePlan,
  assignSubscription,
  cancelSubscription,
  checkLimit,
  comparePlanVersions,
  consumeQuota,
  createPlan,
  createPlanVersion,
  duplicatePlan,
  ensureDefaultFreePlan,
  executeMigration,
  getEffectiveEntitlements,
  getMigrationPreview,
  getPlan,
  getPlanVersion,
  getSubscription,
  getUsage,
  getUserSubscription,
  listPlans,
  listSubscriptions,
  publishPlanVersion,
  recordUsage,
  removeEntitlementOverride,
  requireAdmin,
  setEntitlementOverride,
} from "@sendcms/plans"
import {
  FREE_PLAN_V1_ENTITLEMENTS,
  type PlanEntitlements,
} from "@sendcms/plans/validators"
import { ApiError } from "@sendcms/api-client"

const adminId = "admin-1"
const userId = "user-1"

function makeActor(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: adminId,
      name: "Admin",
      email: "admin@example.com",
      image: null,
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: {
      id: "sess-1",
      userId: adminId,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    },
  }
}

const ownerActor = () =>
  makeActor({ id: "owner-1", platformRole: "PLATFORM_OWNER" })
const managerActor = () => makeActor({ adminRole: "MANAGER" })
const plainUserActor = () => makeActor()

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint", {
    code: "P2002",
    clientVersion: "1.0.0",
  })
}

const proEntitlements: PlanEntitlements = {
  ...FREE_PLAN_V1_ENTITLEMENTS,
  forms: 10,
  domains: 5,
  submissionsPerMonth: 1000,
  apiKeys: 25,
  aiRequestsPerDay: 500,
  mcpRequestsPerMinute: 300,
  mcpRequestsPerHour: 5000,
  features: ["priority-support"],
}

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    planId: "plan-1",
    plan: { name: "Free" },
    version: 1,
    status: "PUBLISHED",
    priceAmount: null,
    priceCurrency: "USD",
    billingInterval: "MONTHLY",
    trialDays: 0,
    entitlements: FREE_PLAN_V1_ENTITLEMENTS,
    changeReason: null,
    publishedAt: new Date("2026-11-01T00:00:00Z"),
    createdById: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  }
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    name: "Free",
    slug: "free",
    description: null,
    kind: "FREE",
    isPrivate: false,
    status: "PUBLISHED",
    currentVersionId: "version-1",
    currentVersion: {
      id: "version-1",
      version: 1,
      priceAmount: null,
      priceCurrency: "USD",
      billingInterval: "MONTHLY",
    },
    _count: { versions: 1, subscriptions: 0 },
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  }
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    userId,
    user: { id: userId, name: "Customer", email: "customer@example.com" },
    planId: "plan-1",
    plan: { id: "plan-1", name: "Free", slug: "free" },
    planVersionId: "version-1",
    planVersion: makeVersion(),
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  }
}

const basePlanInput = {
  name: "Pro",
  slug: "pro",
  kind: "PAID" as const,
  isPrivate: false,
  entitlements: proEntitlements,
}

beforeEach(() => {
  vi.clearAllMocks()
  // Defaults: an ACTIVE user with no subscription and no overrides, so
  // entitlement resolution falls through to the default Free plan.
  mockDb.user.findUnique.mockResolvedValue({ id: userId, status: "ACTIVE" })
  mockDb.entitlementOverride.findMany.mockResolvedValue([])
  mockDb.subscription.findFirst.mockResolvedValue(null)
  mockDb.plan.findFirst.mockResolvedValue({
    ...makePlan(),
    currentVersion: makeVersion(),
  })
})

describe("requireAdmin", () => {
  it("allows the platform owner every capability", () => {
    expect(() => requireAdmin(ownerActor(), "MANAGE_PLANS")).not.toThrow()
    expect(() =>
      requireAdmin(ownerActor(), "MIGRATE_SUBSCRIPTIONS")
    ).not.toThrow()
  })

  it("denies a plain user", () => {
    expect(() => requireAdmin(plainUserActor(), "MANAGE_PLANS")).toThrow(
      ApiError
    )
  })

  it("denies a MANAGER publishing a plan version", () => {
    expect(() => requireAdmin(managerActor(), "PUBLISH_PLAN_VERSIONS")).toThrow(
      ApiError
    )
  })
})

describe("createPlan", () => {
  it("creates a plan with version 1 as a DRAFT", async () => {
    const plan = makePlan({ id: "plan-2", slug: "pro", status: "DRAFT" })
    mockDb.plan.create.mockResolvedValue(plan)
    mockDb.planVersion.create.mockResolvedValue(makeVersion())
    mockDb.plan.findUniqueOrThrow.mockResolvedValue(plan)
    mockDb.planVersion.findMany.mockResolvedValue([makeVersion()])

    const created = await createPlan(ownerActor(), basePlanInput)

    expect(mockDb.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "pro", status: "DRAFT" }),
      })
    )
    expect(mockDb.planVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 1, status: "DRAFT" }),
      })
    )
    expect(created.versions[0].version).toBe(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        resourceType: "PLAN",
      })
    )
  })

  it("rejects a duplicate slug with 409", async () => {
    mockDb.plan.create.mockRejectedValue(p2002())
    await expect(createPlan(ownerActor(), basePlanInput)).rejects.toMatchObject(
      { status: 409 }
    )
  })

  it("rejects invalid entitlements with 400", async () => {
    await expect(
      createPlan(ownerActor(), {
        ...basePlanInput,
        entitlements: { ...proEntitlements, apiKeys: -1 },
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(mockDb.plan.create).not.toHaveBeenCalled()
  })

  it("denies a plain user with 403", async () => {
    await expect(
      createPlan(plainUserActor(), basePlanInput)
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("getPlanVersion", () => {
  it("returns a single version with its parsed entitlements", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    const version = await getPlanVersion(ownerActor(), "version-1")
    expect(version.version).toBe(1)
    expect(version.status).toBe("PUBLISHED")
    expect(version.entitlements).toEqual(FREE_PLAN_V1_ENTITLEMENTS)
  })
})

describe("createPlanVersion", () => {
  it("creates a new DRAFT version and leaves the published version untouched", async () => {
    mockDb.plan.findUnique.mockResolvedValue(makePlan())
    mockDb.planVersion.findFirst.mockResolvedValue(makeVersion())
    mockDb.planVersion.create.mockResolvedValue(
      makeVersion({ id: "version-2", version: 2, status: "DRAFT" })
    )

    const version = await createPlanVersion(ownerActor(), "plan-1", {
      entitlements: proEntitlements,
      changeReason: "Raise limits",
    })

    expect(mockDb.planVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2, status: "DRAFT" }),
      })
    )
    expect(version.version).toBe(2)
    expect(version.status).toBe("DRAFT")
    // The published version is never updated in place.
    expect(mockDb.planVersion.update).not.toHaveBeenCalled()
  })

  it("rejects a new version on an archived plan with 409", async () => {
    mockDb.plan.findUnique.mockResolvedValue(makePlan({ status: "ARCHIVED" }))
    await expect(
      createPlanVersion(ownerActor(), "plan-1", {
        entitlements: proEntitlements,
      })
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("publishPlanVersion", () => {
  it("supersedes the previous published version and sets the current version", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(
      makeVersion({ id: "version-2", version: 2, status: "DRAFT" })
    )
    mockDb.plan.findUnique.mockResolvedValue(makePlan())
    mockDb.planVersion.update.mockResolvedValue(
      makeVersion({ id: "version-2", version: 2, status: "PUBLISHED" })
    )

    const published = await publishPlanVersion(
      ownerActor(),
      "plan-1",
      "version-2",
      {
        reason: "Ship the new limits",
      }
    )

    const updateCalls = mockDb.planVersion.update.mock.calls
    expect(updateCalls).toContainEqual([
      expect.objectContaining({
        where: { id: "version-1" },
        data: { status: "SUPERSEDED" },
      }),
    ])
    expect(updateCalls).toContainEqual([
      expect.objectContaining({
        where: { id: "version-2" },
        data: expect.objectContaining({ status: "PUBLISHED" }),
      }),
    ])
    expect(mockDb.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1" },
        data: expect.objectContaining({ currentVersionId: "version-2" }),
      })
    )
    expect(published.status).toBe("PUBLISHED")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PUBLISH",
        resourceType: "PLAN",
        detail: expect.objectContaining({ reason: "Ship the new limits" }),
      })
    )
  })

  it("rejects publishing a non-draft version with 409", async () => {
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    await expect(
      publishPlanVersion(ownerActor(), "plan-1", "version-1", {
        reason: "Again",
      })
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("duplicatePlan + archivePlan", () => {
  it("duplicates the current version's entitlements into a new plan v1 DRAFT", async () => {
    mockDb.plan.findUnique.mockResolvedValue(makePlan())
    mockDb.planVersion.findUnique.mockResolvedValue(makeVersion())
    mockDb.plan.create.mockResolvedValue(
      makePlan({ id: "plan-2", name: "Pro copy", slug: "pro-copy" })
    )
    mockDb.plan.findUniqueOrThrow.mockResolvedValue(
      makePlan({ id: "plan-2", name: "Pro copy", slug: "pro-copy" })
    )
    mockDb.planVersion.findMany.mockResolvedValue([makeVersion()])

    const copy = await duplicatePlan(ownerActor(), "plan-1", {
      name: "Pro copy",
      slug: "pro-copy",
    })

    expect(mockDb.planVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 1,
          status: "DRAFT",
          entitlements: FREE_PLAN_V1_ENTITLEMENTS,
        }),
      })
    )
    expect(copy.slug).toBe("pro-copy")
  })

  it("archives the plan, its versions, and clears the current version", async () => {
    mockDb.plan.findUnique.mockResolvedValue(makePlan())
    mockDb.plan.update.mockResolvedValue(
      makePlan({ status: "ARCHIVED", currentVersionId: null })
    )

    const archived = await archivePlan(ownerActor(), "plan-1", {})

    expect(mockDb.planVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ARCHIVED" } })
    )
    expect(mockDb.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ARCHIVED",
          currentVersionId: null,
        }),
      })
    )
    expect(archived.status).toBe("ARCHIVED")
  })
})

describe("comparePlanVersions", () => {
  it("returns field-level old/new pairs", async () => {
    mockDb.planVersion.findUnique
      .mockResolvedValueOnce(makeVersion())
      .mockResolvedValueOnce(
        makeVersion({
          id: "version-2",
          version: 2,
          priceAmount: 1999,
          entitlements: proEntitlements,
        })
      )

    const diff = await comparePlanVersions(
      ownerActor(),
      "version-1",
      "version-2"
    )

    const byField = new Map(diff.changes.map((c) => [c.field, c]))
    expect(byField.get("priceAmount")).toMatchObject({
      from: null,
      to: 1999,
    })
    expect(byField.get("forms")).toMatchObject({ from: null, to: 10 })
    expect(byField.get("submissionsPerMonth")).toMatchObject({
      from: null,
      to: 1000,
    })
    expect(byField.get("domains")).toMatchObject({ from: null, to: 5 })
    // Unchanged fields are not in the diff.
    expect(byField.has("aiByokAllowed")).toBe(false)
  })
})

describe("assignSubscription", () => {
  it("cancels the previous subscription and creates the new one in one transaction", async () => {
    const previous = makeSubscription()
    const targetVersion = makeVersion({
      id: "version-2",
      planId: "plan-2",
      plan: { name: "Pro" },
      version: 1,
      entitlements: proEntitlements,
    })
    mockDb.user.findUnique.mockResolvedValue({ id: userId })
    mockDb.planVersion.findUnique.mockResolvedValue(targetVersion)
    mockDb.subscription.findFirst.mockResolvedValue(previous)
    mockDb.subscription.create.mockResolvedValue(
      makeSubscription({
        id: "sub-2",
        planId: "plan-2",
        planVersionId: "version-2",
        planVersion: targetVersion,
      })
    )
    mockDb.subscription.findUniqueOrThrow.mockResolvedValue(
      makeSubscription({
        id: "sub-2",
        planId: "plan-2",
        planVersionId: "version-2",
        planVersion: targetVersion,
      })
    )

    const created = await assignSubscription(ownerActor(), {
      userId,
      planVersionId: "version-2",
      reason: "Upgrade to Pro",
    })

    expect(mockDb.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-1" },
        data: { status: "CANCELED" },
      })
    )
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId: "sub-1",
          type: "CANCELED",
        }),
      })
    )
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "CREATED",
          toPlanVersionId: "version-2",
        }),
      })
    )
    expect(created.planVersionId).toBe("version-2")
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ASSIGN",
        resourceType: "SUBSCRIPTION",
      })
    )
  })

  it("rejects a non-published version with 409", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: userId })
    mockDb.planVersion.findUnique.mockResolvedValue(
      makeVersion({ status: "DRAFT" })
    )
    await expect(
      assignSubscription(ownerActor(), {
        userId,
        planVersionId: "version-1",
        reason: "Assign",
      })
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("getUserSubscription", () => {
  it("returns the active subscription with its effective entitlements", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(makeSubscription())

    const sub = await getUserSubscription(ownerActor(), userId)

    expect(sub?.planVersionId).toBe("version-1")
    expect(sub?.entitlements).toEqual(FREE_PLAN_V1_ENTITLEMENTS)
  })

  it("returns null when the user has no subscription", async () => {
    const sub = await getUserSubscription(ownerActor(), userId)
    expect(sub).toBeNull()
  })
})

describe("getMigrationPreview", () => {
  it("lists affected users with before/after comparison and skips users already on the target", async () => {
    const target = makeVersion({
      id: "version-2",
      planId: "plan-2",
      plan: { name: "Pro" },
      version: 1,
      priceAmount: 1999,
      entitlements: proEntitlements,
    })
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    mockDb.plan.findUniqueOrThrow.mockResolvedValue({
      id: "plan-2",
      name: "Pro",
      slug: "pro",
    })
    mockDb.subscription.findMany.mockResolvedValue([
      makeSubscription(),
      makeSubscription({
        id: "sub-2",
        userId: "user-2",
        user: { id: "user-2", name: "Two", email: "two@example.com" },
        planVersionId: "version-2",
        planVersion: target,
      }),
    ])

    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      userIds: [userId, "user-2"],
    })

    expect(preview.affectedCount).toBe(1)
    expect(preview.users).toHaveLength(1)
    expect(preview.users[0].userId).toBe(userId)
    expect(preview.users[0].fromVersion?.version).toBe(1)
    expect(preview.users[0].toVersion.version).toBe(1)
    expect(preview.users[0].priceChange).toMatchObject({
      from: null,
      to: 1999,
    })
    const fields = new Map(
      preview.users[0].limitsChange.map((c) => [c.field, c])
    )
    expect(fields.get("forms")).toMatchObject({ from: null, to: 10 })
    expect(preview.skippedUserIds).toContain("user-2")
  })

  it("supports migrating everyone on one version", async () => {
    const target = makeVersion({
      id: "version-2",
      planId: "plan-2",
      plan: { name: "Pro" },
      version: 1,
      entitlements: proEntitlements,
    })
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    mockDb.plan.findUniqueOrThrow.mockResolvedValue({
      id: "plan-2",
      name: "Pro",
      slug: "pro",
    })
    mockDb.subscription.findMany.mockResolvedValue([
      makeSubscription(),
      makeSubscription({
        id: "sub-2",
        userId: "user-2",
        user: { id: "user-2", name: "Two", email: "two@example.com" },
      }),
    ])

    const preview = await getMigrationPreview(ownerActor(), {
      planVersionId: "version-2",
      allOnVersionId: "version-1",
    })

    expect(preview.affectedCount).toBe(2)
  })
})

describe("executeMigration", () => {
  it("updates ONLY the selected subscriptions", async () => {
    const target = makeVersion({
      id: "version-2",
      planId: "plan-2",
      plan: { name: "Pro" },
      version: 1,
      entitlements: proEntitlements,
    })
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    // findActiveSubscription is called once per userId, in order.
    mockDb.subscription.findFirst.mockResolvedValue(makeSubscription())

    const result = await executeMigration(ownerActor(), {
      planVersionId: "version-2",
      userIds: [userId],
      reason: "Move to Pro",
    })

    expect(result).toMatchObject({
      migratedUserIds: [userId],
      skippedUserIds: [],
      count: 1,
    })
    expect(mockDb.subscription.update).toHaveBeenCalledTimes(1)
    expect(mockDb.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-1" },
        data: { planId: "plan-2", planVersionId: "version-2" },
      })
    )
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId: "sub-1",
          type: "MIGRATED",
          fromPlanVersionId: "version-1",
          toPlanVersionId: "version-2",
        }),
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MIGRATE",
        resourceType: "SUBSCRIPTION",
      })
    )
  })

  it("skips users already on the target version", async () => {
    const target = makeVersion({
      id: "version-2",
      planId: "plan-2",
      plan: { name: "Pro" },
      version: 1,
      entitlements: proEntitlements,
    })
    mockDb.planVersion.findUnique.mockResolvedValue(target)
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({ planVersionId: "version-2", planVersion: target })
    )

    const result = await executeMigration(ownerActor(), {
      planVersionId: "version-2",
      userIds: [userId],
      reason: "No-op",
    })

    expect(result).toMatchObject({
      migratedUserIds: [],
      skippedUserIds: [userId],
      count: 0,
    })
    expect(mockDb.subscription.update).not.toHaveBeenCalled()
  })
})

describe("cancelSubscription", () => {
  it("cancels immediately with a CANCELED event", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(makeSubscription())
    mockDb.subscription.update.mockResolvedValue(
      makeSubscription({ status: "CANCELED" })
    )

    const canceled = await cancelSubscription(ownerActor(), "sub-1", {})

    expect(canceled.status).toBe("CANCELED")
    expect(mockDb.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCELED" }),
      })
    )
  })

  it("keeps the subscription ACTIVE when cancelAtPeriodEnd is set", async () => {
    mockDb.subscription.findUnique.mockResolvedValue(makeSubscription())
    mockDb.subscription.update.mockResolvedValue(
      makeSubscription({ cancelAtPeriodEnd: true })
    )

    const canceled = await cancelSubscription(ownerActor(), "sub-1", {
      cancelAtPeriodEnd: true,
    })

    expect(canceled.status).toBe("ACTIVE")
    expect(canceled.cancelAtPeriodEnd).toBe(true)
    expect(mockDb.subscriptionEvent.create).not.toHaveBeenCalled()
  })
})

describe("plan history after migration", () => {
  it("keeps historical versions and subscription events readable", async () => {
    mockDb.plan.findUnique.mockResolvedValue(makePlan())
    mockDb.planVersion.findMany.mockResolvedValue([
      makeVersion({ id: "version-2", version: 2, status: "PUBLISHED" }),
      makeVersion(),
    ])
    const plan = await getPlan(ownerActor(), "plan-1")
    expect(plan.versions).toHaveLength(2)
    expect(plan.versions.map((v) => v.version)).toEqual([2, 1])

    mockDb.subscription.findUnique.mockResolvedValue({
      ...makeSubscription(),
      events: [
        {
          id: "ev-1",
          type: "MIGRATED",
          fromPlanVersion: { id: "version-1", version: 1 },
          toPlanVersion: { id: "version-2", version: 2 },
          adminId: adminId,
          admin: { id: adminId, name: "Admin", email: "admin@example.com" },
          reason: "Move to Pro",
          createdAt: new Date("2026-11-21T00:00:00Z"),
        },
      ],
    })
    const sub = await getSubscription(ownerActor(), "sub-1")
    expect(sub.events).toHaveLength(1)
    expect(sub.events[0].type).toBe("MIGRATED")
    expect(sub.events[0].fromPlanVersion?.version).toBe(1)
    expect(sub.events[0].toPlanVersion?.version).toBe(2)
  })
})

describe("getEffectiveEntitlements", () => {
  it("falls back to the default Free plan with no subscription", async () => {
    const effective = await getEffectiveEntitlements(userId)
    expect(effective.source).toBe("free")
    expect(effective.entitlements).toEqual(FREE_PLAN_V1_ENTITLEMENTS)
    expect(effective.planVersionId).toBe("version-1")
    expect(effective.denied).toBeUndefined()
  })

  it("uses the subscription's effective version, not the plan's current one", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        planVersion: makeVersion({ entitlements: proEntitlements }),
      })
    )
    const effective = await getEffectiveEntitlements(userId)
    expect(effective.source).toBe("subscription")
    expect(effective.entitlements).toEqual(proEntitlements)
    expect(effective.planVersionId).toBe("version-1")
  })

  it("lets an override beat the subscription", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        planVersion: makeVersion({ entitlements: proEntitlements }),
      })
    )
    mockDb.entitlementOverride.findMany.mockResolvedValue([
      {
        id: "ov-1",
        userId,
        meter: "FORMS",
        value: 3,
        reason: "Trial",
        adminId: adminId,
        expiresAt: null,
      },
    ])
    const effective = await getEffectiveEntitlements(userId)
    expect(effective.source).toBe("override")
    expect(effective.overriddenMeters).toEqual(["FORMS"])
    expect(effective.entitlements?.forms).toBe(3)
    // Other limits still come from the subscription.
    expect(effective.entitlements?.apiKeys).toBe(25)
  })

  it("denies a suspended user entirely", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      status: "SUSPENDED",
    })
    const effective = await getEffectiveEntitlements(userId)
    expect(effective.entitlements).toBeNull()
    expect(effective.denied).toBe("suspended")
  })
})

describe("ensureDefaultFreePlan", () => {
  it("creates the Free plan with published version 1 when none exists", async () => {
    mockDb.plan.findFirst.mockResolvedValue(null)
    mockDb.plan.create.mockResolvedValue(makePlan())
    mockDb.planVersion.create.mockResolvedValue(makeVersion())
    mockDb.plan.update.mockResolvedValue({
      ...makePlan(),
      currentVersion: makeVersion(),
    })

    const free = await ensureDefaultFreePlan()

    expect(mockDb.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "free", kind: "FREE" }),
      })
    )
    expect(mockDb.planVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 1,
          status: "PUBLISHED",
          entitlements: FREE_PLAN_V1_ENTITLEMENTS,
        }),
      })
    )
    expect(free?.slug).toBe("free")
  })

  it("re-reads instead of creating when the Free plan already exists", async () => {
    const free = await ensureDefaultFreePlan()
    expect(free?.slug).toBe("free")
    expect(mockDb.plan.create).not.toHaveBeenCalled()
    expect(mockDb.planVersion.create).not.toHaveBeenCalled()
  })
})

describe("recordUsage + getUsage", () => {
  it("counts a repeated idempotencyKey once", async () => {
    const row = {
      id: "usage-1",
      userId,
      meter: "SUBMISSIONS",
      quantity: 1,
      unit: "submission",
      period: new Date("2026-11-01T00:00:00Z"),
      sourceEvent: "submission:created",
      idempotencyKey: "sub-1",
      resourceId: "sub-1",
      createdAt: new Date(),
    }
    mockDb.usageLedger.create
      .mockResolvedValueOnce(row)
      .mockRejectedValueOnce(p2002())
    mockDb.usageLedger.findUnique.mockResolvedValue(row)

    const input = {
      userId,
      meter: "SUBMISSIONS" as const,
      unit: "submission",
      period: "2026-11-01T00:00:00.000Z",
      sourceEvent: "submission:created",
      idempotencyKey: "sub-1",
      resourceId: "sub-1",
    }
    const first = await recordUsage(input)
    const second = await recordUsage(input)

    expect(first.id).toBe("usage-1")
    expect(second.id).toBe("usage-1")
    expect(mockDb.usageLedger.create).toHaveBeenCalledTimes(2)
  })

  it("sums quantities for a period bucket", async () => {
    mockDb.usageLedger.aggregate.mockResolvedValue({ _sum: { quantity: 42 } })
    const usage = await getUsage(
      userId,
      "SUBMISSIONS",
      new Date("2026-11-01T00:00:00Z")
    )
    expect(usage.total).toBe(42)
    expect(usage.meter).toBe("SUBMISSIONS")
  })
})

describe("checkLimit + consumeQuota", () => {
  it("allows under the Free plan's unlimited forms limit", async () => {
    mockDb.form.count.mockResolvedValue(10)
    const check = await checkLimit(userId, "FORMS")
    // The default Free plan has forms: null (unlimited).
    expect(check.allowed).toBe(true)
    expect(check.limit).toBeNull()
    expect(check.remaining).toBeNull()
  })

  it("denies when over and allows when under a subscription limit", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        planVersion: makeVersion({ entitlements: proEntitlements }),
      })
    )
    mockDb.form.count.mockResolvedValue(10)
    const over = await checkLimit(userId, "FORMS")
    expect(over).toMatchObject({
      allowed: false,
      limit: 10,
      used: 10,
      remaining: 0,
    })

    mockDb.form.count.mockResolvedValue(3)
    const under = await checkLimit(userId, "FORMS")
    expect(under).toMatchObject({
      allowed: true,
      limit: 10,
      used: 3,
      remaining: 7,
    })
  })

  it("treats a null limit as unlimited", async () => {
    mockDb.form.count.mockResolvedValue(10_000)
    const check = await checkLimit(userId, "FORMS")
    expect(check).toMatchObject({
      allowed: true,
      limit: null,
      used: 10_000,
      remaining: null,
    })
  })

  it("consumeQuota records nothing when over the limit", async () => {
    mockDb.subscription.findFirst.mockResolvedValue(
      makeSubscription({
        planVersion: makeVersion({ entitlements: proEntitlements }),
      })
    )
    mockDb.form.count.mockResolvedValue(10)
    const result = await consumeQuota(userId, {
      meter: "FORMS",
      unit: "form",
      idempotencyKey: "form-1",
    })
    expect(result.allowed).toBe(false)
    expect(result.recorded).toBe(false)
    expect(mockDb.usageLedger.create).not.toHaveBeenCalled()
  })
})

describe("setEntitlementOverride + removeEntitlementOverride", () => {
  it("upserts an override by [userId, meter] and audits it", async () => {
    mockDb.entitlementOverride.upsert.mockResolvedValue({
      id: "ov-1",
      userId,
      user: { id: userId, name: "Customer", email: "customer@example.com" },
      meter: "FORMS",
      value: 5,
      reason: "Trial",
      adminId: adminId,
      admin: { id: adminId, name: "Admin", email: "admin@example.com" },
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const row = await setEntitlementOverride(ownerActor(), userId, {
      meter: "FORMS",
      value: 5,
      reason: "Trial",
    })
    expect(row.value).toBe(5)
    expect(mockDb.entitlementOverride.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_meter: { userId, meter: "FORMS" } },
      })
    )
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE",
        resourceType: "ENTITLEMENT",
      })
    )
  })

  it("rejects a null value for API_KEYS and MCP_REQUESTS", async () => {
    await expect(
      setEntitlementOverride(ownerActor(), userId, {
        meter: "API_KEYS",
        value: null,
        reason: "Unlimited keys",
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      setEntitlementOverride(ownerActor(), userId, {
        meter: "MCP_REQUESTS",
        value: null,
        reason: "Unlimited MCP",
      })
    ).rejects.toMatchObject({ status: 400 })
  })

  it("removes an override and reports when there is none", async () => {
    mockDb.entitlementOverride.findUnique.mockResolvedValueOnce({
      id: "ov-1",
    })
    mockDb.entitlementOverride.delete.mockResolvedValue({ id: "ov-1" })
    const removed = await removeEntitlementOverride(
      ownerActor(),
      userId,
      "FORMS"
    )
    expect(removed).toEqual({ deleted: true })

    mockDb.entitlementOverride.findUnique.mockResolvedValueOnce(null)
    const missing = await removeEntitlementOverride(
      ownerActor(),
      userId,
      "FORMS"
    )
    expect(missing).toEqual({ deleted: false })
  })
})

describe("listPlans + listSubscriptions", () => {
  it("lists plans with status/kind filters and pagination", async () => {
    mockDb.plan.count.mockResolvedValue(1)
    mockDb.plan.findMany.mockResolvedValue([makePlan()])
    const result = await listPlans(ownerActor(), {
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
      status: "PUBLISHED",
      kind: "FREE",
    })
    expect(result.total).toBe(1)
    expect(result.plans).toHaveLength(1)
    expect(mockDb.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PUBLISHED",
          kind: "FREE",
        }),
      })
    )
  })

  it("lists subscriptions filtered by user", async () => {
    mockDb.subscription.count.mockResolvedValue(1)
    mockDb.subscription.findMany.mockResolvedValue([makeSubscription()])
    const result = await listSubscriptions(ownerActor(), {
      page: 1,
      perPage: 20,
      sort: "createdAt:desc",
      userId,
    })
    expect(result.total).toBe(1)
    expect(result.subscriptions[0].userId).toBe(userId)
  })
})
