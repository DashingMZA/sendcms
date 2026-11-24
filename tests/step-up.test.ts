// Step-up re-authentication (Admin Control Plane, Phase 9) with a
// mocked Prisma client. The real @sendcms/security helpers AND the
// real better-auth password check run — only the database is stubbed,
// with an in-memory fake for the step-up rows and the rate-limit
// buckets. The account password below is a real scrypt hash (made by
// better-auth's hashPassword) of the test password, so the check
// exercises the real crypto; no test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import {
  consumeStepUpVerification,
  findStepUpVerification,
  parseStepUpConfig,
  pruneStepUpVerifications,
  readStepUpConfig,
  requireStepUp,
  resetStepUpConfigCache,
  verifyStepUp,
} from "@sendcms/security"
import { disableUser, setAdminRole } from "@sendcms/admin-users"
import { executeErasure, reviewDeletionRequest } from "@sendcms/platform-ops"
import { revokeMcpKey, setMcpSettings } from "@sendcms/mcp-admin"

type StoredBucket = {
  scope: string
  subject: string
  minuteWindowStart: Date
  minuteCount: number
  hourWindowStart: Date
  hourCount: number
}

type StoredVerification = {
  id: string
  userId: string
  action: string | null
  verifiedAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

const { buckets, mockQueryRaw, mockDb, verifications, auditCreates } =
  vi.hoisted(() => {
    const buckets = new Map<string, StoredBucket>()
    const verifications: StoredVerification[] = []
    const auditCreates: Record<string, unknown>[] = []
    // Same in-memory fake as the rate-limit test: mirrors the
    // single INSERT ... ON CONFLICT ... RETURNING statement.
    const mockQueryRaw = vi.fn(async (first: unknown, ...rest: unknown[]) => {
      const values =
        first !== null &&
        typeof first === "object" &&
        "values" in (first as Record<string, unknown>) &&
        Array.isArray((first as { values: unknown[] }).values)
          ? (first as { values: unknown[] }).values
          : rest
      const [scope, subject, minuteStart, hourStart] = values as [
        string,
        string,
        Date,
        Date,
      ]
      const key = `${scope}|${subject}`
      const existing = buckets.get(key)
      if (!existing) {
        const row: StoredBucket = {
          scope,
          subject,
          minuteWindowStart: minuteStart,
          minuteCount: 1,
          hourWindowStart: hourStart,
          hourCount: 1,
        }
        buckets.set(key, row)
        return [
          {
            minuteCount: 1,
            hourCount: 1,
            minuteWindowStart: minuteStart,
            hourWindowStart: hourStart,
          },
        ]
      }
      const minuteCount =
        existing.minuteWindowStart.getTime() === minuteStart.getTime()
          ? existing.minuteCount + 1
          : 1
      const hourCount =
        existing.hourWindowStart.getTime() === hourStart.getTime()
          ? existing.hourCount + 1
          : 1
      existing.minuteWindowStart = minuteStart
      existing.minuteCount = minuteCount
      existing.hourWindowStart = hourStart
      existing.hourCount = hourCount
      return [
        {
          minuteCount,
          hourCount,
          minuteWindowStart: minuteStart,
          hourWindowStart: hourStart,
        },
      ]
    })
    const mockDb = {
      $queryRaw: mockQueryRaw,
      $transaction: vi.fn(async (ops: unknown) =>
        Array.isArray(ops)
          ? Promise.all(ops as Promise<unknown>[])
          : (ops as (tx: unknown) => Promise<unknown>)(mockDb)
      ),
      account: { findFirst: vi.fn() },
      stepUpVerification: {
        create: vi.fn(async ({ data }: { data: StoredVerification }) => {
          const row = {
            ...data,
            id: `sv-${verifications.length + 1}`,
            action: data.action ?? null,
            consumedAt: null,
            createdAt: data.verifiedAt,
          }
          verifications.push(row)
          return row
        }),
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: {
              userId: string
              action: string | null
              consumedAt: null
              expiresAt: { gt: Date }
            }
          }) => {
            const rows = verifications
              .filter(
                (v) =>
                  v.userId === where.userId &&
                  (v.action ?? null) === (where.action ?? null) &&
                  v.consumedAt === null &&
                  v.expiresAt > where.expiresAt.gt
              )
              .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())
            return rows[0] ?? null
          }
        ),
        updateMany: vi.fn(
          async ({ where }: { where: { id: string; consumedAt: null } }) => {
            const row = verifications.find((v) => v.id === where.id)
            if (!row || row.consumedAt !== null) return { count: 0 }
            row.consumedAt = new Date()
            return { count: 1 }
          }
        ),
        deleteMany: vi.fn(
          async ({
            where,
          }: {
            where: {
              OR: [{ expiresAt: { lte: Date } }, { consumedAt: { not: null } }]
            }
          }) => {
            const expiredAt = where.OR[0].expiresAt.lte
            let count = 0
            for (let i = verifications.length - 1; i >= 0; i--) {
              const row = verifications[i]
              if (row.expiresAt <= expiredAt || row.consumedAt !== null) {
                verifications.splice(i, 1)
                count++
              }
            }
            return { count }
          }
        ),
      },
      auditLog: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditCreates.push(data)
          return { id: "audit-1", ...data }
        }),
      },
      user: { findUnique: vi.fn(), update: vi.fn() },
      session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      deletionRequest: { findUnique: vi.fn(), update: vi.fn() },
      apiKey: { findUnique: vi.fn(), update: vi.fn() },
      mcpSettings: { findFirst: vi.fn(), upsert: vi.fn() },
    }
    return {
      buckets,
      mockQueryRaw,
      mockDb,
      verifications,
      auditCreates,
    }
  })

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

const T = new Date("2026-11-22T07:00:00.000Z")
const T_PLUS_9MIN = new Date(T.getTime() + 9 * 60_000)
const T_PLUS_11MIN = new Date(T.getTime() + 11 * 60_000)
const PASSWORD = "correct-horse-battery-staple"
// Real scrypt hash of PASSWORD, made by better-auth's hashPassword
// (a test fixture — the password is a test password, not a secret).
const PASSWORD_HASH =
  "37564631476744270482fd1281fb0cb3:58e877b12e9ad3d21772522f5ac8057d2e9be4853cbc9783402ce0f8443b9319c9bb5a1e87d34382aac6654962d855291dc042bcd8b008afd8974cc2da15d0ad"

const OWNER: AdminSession = {
  user: {
    id: "admin-1",
    name: "Admin",
    email: "admin@example.com",
    image: null,
    platformRole: "PLATFORM_OWNER",
    status: "ACTIVE",
    adminRole: null,
    emailVerified: true,
  },
  session: {
    id: "sess-1",
    userId: "admin-1",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  },
}

const TARGET = {
  id: "user-2",
  platformRole: "PLATFORM_USER",
  status: "ACTIVE",
  adminRole: null,
  email: "user@example.com",
  emailVerified: true,
}

async function expectStepUpRequired(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    status: 403,
    message: expect.stringContaining("Step-up verification required"),
  })
}

beforeEach(() => {
  buckets.clear()
  verifications.length = 0
  auditCreates.length = 0
  mockQueryRaw.mockClear()
  mockDb.account.findFirst.mockResolvedValue({ password: PASSWORD_HASH })
  mockDb.user.findUnique.mockResolvedValue(TARGET)
  mockDb.user.update.mockResolvedValue({ id: "user-2", status: "DISABLED" })
  mockDb.deletionRequest.findUnique.mockResolvedValue({
    id: "req-1",
    userId: "user-2",
    status: "REQUESTED",
    user: {
      id: "user-2",
      name: "User",
      email: "user@example.com",
      platformRole: "PLATFORM_USER",
      status: "ACTIVE",
      deletionCompletedAt: null,
    },
  })
  mockDb.deletionRequest.update.mockImplementation(
    async ({ data }: { data: { status: string } }) => ({
      id: "req-1",
      userId: "user-2",
      status: data.status,
    })
  )
  mockDb.apiKey.findUnique.mockResolvedValue({
    id: "key-1",
    userId: "user-2",
    name: "key",
  })
  mockDb.mcpSettings.findFirst.mockResolvedValue({ globalEnabled: true })
  mockDb.mcpSettings.upsert.mockResolvedValue({ globalEnabled: false })
  for (const fn of [
    mockDb.account.findFirst,
    mockDb.stepUpVerification.create,
    mockDb.stepUpVerification.findFirst,
    mockDb.stepUpVerification.updateMany,
    mockDb.stepUpVerification.deleteMany,
    mockDb.auditLog.create,
    mockDb.user.update,
    mockDb.deletionRequest.update,
    mockDb.apiKey.update,
    mockDb.mcpSettings.upsert,
    mockDb.$transaction,
  ]) {
    fn.mockClear()
  }
  resetStepUpConfigCache()
})

describe("parseStepUpConfig / readStepUpConfig", () => {
  it("defaults when the key is missing", () => {
    expect(parseStepUpConfig({})).toEqual({
      ttlMinutes: 10,
      maxAttemptsPerHour: 5,
    })
  })

  it("reads the configured values and falls back per field", () => {
    expect(
      parseStepUpConfig({ stepUp: { ttlMinutes: 30, maxAttemptsPerHour: 2 } })
    ).toEqual({ ttlMinutes: 30, maxAttemptsPerHour: 2 })
    expect(parseStepUpConfig({ stepUp: { ttlMinutes: "ten" } })).toEqual({
      ttlMinutes: 10,
      maxAttemptsPerHour: 5,
    })
  })

  it("reads the repo config file (10 minutes, 5/hour)", () => {
    expect(readStepUpConfig()).toEqual({
      ttlMinutes: 10,
      maxAttemptsPerHour: 5,
    })
  })
})

describe("verifyStepUp", () => {
  it(
    "verifies the password, records a row expiring in 10 minutes, and returns only the expiry",
    // TST-010: scrypt is slow under load; the default 5 s timeout
    // flaked this test when the suite ran ~2x slower.
    { timeout: 30_000 },
    async () => {
      const result = await verifyStepUp(OWNER, PASSWORD, { now: T })
      expect(result).toEqual({
        verifiedUntil: new Date(T.getTime() + 10 * 60_000),
      })
      // The response carries nothing else — no password, no hash.
      expect(JSON.stringify(result)).not.toContain(PASSWORD)
      expect(mockDb.stepUpVerification.create).toHaveBeenCalledTimes(1)
      const created = mockDb.stepUpVerification.create.mock.calls[0][0]
        .data as StoredVerification
      expect(created.userId).toBe("admin-1")
      expect(created.expiresAt).toEqual(new Date(T.getTime() + 10 * 60_000))
    }
  )

  it("audits success without the password anywhere in the detail", async () => {
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    const verified = auditCreates.filter(
      (row) => row.action === "STEP_UP_VERIFIED"
    )
    expect(verified).toHaveLength(1)
    expect(verified[0].detail).toEqual({ event: "step-up-verified" })
    expect(JSON.stringify(auditCreates)).not.toContain(PASSWORD)
  })

  it("wrong password → 403, no row, audited as failed", async () => {
    await expect(
      verifyStepUp(OWNER, "not-the-password", { now: T })
    ).rejects.toMatchObject({
      status: 403,
      message: "Incorrect password.",
    })
    expect(mockDb.stepUpVerification.create).not.toHaveBeenCalled()
    const failed = auditCreates.filter((row) => row.action === "STEP_UP_FAILED")
    expect(failed).toHaveLength(1)
    expect(failed[0].detail).toEqual({
      event: "step-up-failed",
      reason: "wrong-password",
    })
    expect(JSON.stringify(auditCreates)).not.toContain("not-the-password")
  })

  it("OAuth-only account (no credential row) → 422, fail closed", async () => {
    mockDb.account.findFirst.mockResolvedValue(null)
    await expect(
      verifyStepUp(OWNER, PASSWORD, { now: T })
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("No password is set"),
    })
    expect(mockDb.stepUpVerification.create).not.toHaveBeenCalled()
  })

  it("credential account with a null password → 422, fail closed", async () => {
    mockDb.account.findFirst.mockResolvedValue({ password: null })
    await expect(
      verifyStepUp(OWNER, PASSWORD, { now: T })
    ).rejects.toMatchObject({
      status: 422,
    })
    expect(mockDb.stepUpVerification.create).not.toHaveBeenCalled()
  })

  it("empty password → 422 without consuming an attempt", async () => {
    await expect(verifyStepUp(OWNER, "", { now: T })).rejects.toMatchObject({
      status: 422,
    })
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  // TST-010: six sequential scrypt verifications exceed the 5 s
  // default timeout when the suite runs ~2x slower under load, and
  // the failure then cascades (the counter never reaches 5, so the
  // next assertion sees 403 instead of 429). The timeout is raised,
  // and the test uses its own actor id so its five consumed attempts
  // can never leak into another test's rate-limit bucket even if the
  // per-test bucket clear is ever skipped.
  it(
    "5 wrong attempts in an hour → the 6th is 429, and the password is never checked again",
    { timeout: 30_000 },
    async () => {
      const attemptsActor: AdminSession = {
        ...OWNER,
        user: { ...OWNER.user, id: "admin-attempts" },
        session: { ...OWNER.session, userId: "admin-attempts" },
      }
      for (let i = 0; i < 5; i++) {
        await expect(
          verifyStepUp(attemptsActor, "not-the-password", { now: T })
        ).rejects.toMatchObject({
          status: 403,
        })
      }
      await expect(
        verifyStepUp(attemptsActor, "not-the-password", { now: T })
      ).rejects.toMatchObject({
        status: 429,
      })
      // The 6th call died in the limiter: the account row was read 5
      // times, never a 6th.
      expect(mockDb.account.findFirst).toHaveBeenCalledTimes(5)
      expect(mockDb.stepUpVerification.create).not.toHaveBeenCalled()
    }
  )
})

describe("requireStepUp", () => {
  it("accepts an unexpired verification", async () => {
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    const result = await requireStepUp(OWNER, { now: T_PLUS_9MIN })
    expect(result).toEqual({
      verifiedUntil: new Date(T.getTime() + 10 * 60_000),
    })
  })

  it("rejects when no verification exists", async () => {
    await expectStepUpRequired(requireStepUp(OWNER, { now: T }))
  })

  it("rejects an expired verification (TTL is 10 minutes)", async () => {
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    await expectStepUpRequired(requireStepUp(OWNER, { now: T_PLUS_11MIN }))
  })
})

describe("action binding and single-use (SRC-319)", () => {
  it(
    "binds the row to the action and consumes it on first use",
    { timeout: 30_000 },
    async () => {
      await verifyStepUp(OWNER, PASSWORD, {
        action: "change-password",
        now: T,
      })
      const created = mockDb.stepUpVerification.create.mock.calls[0][0]
        .data as StoredVerification
      expect(created.action).toBe("change-password")
      const result = await requireStepUp(OWNER, {
        action: "change-password",
        now: T_PLUS_9MIN,
      })
      expect(result).toEqual({
        verifiedUntil: new Date(T.getTime() + 10 * 60_000),
      })
      expect(mockDb.stepUpVerification.updateMany).toHaveBeenCalledTimes(1)
      // Replay of the consumed proof → 403.
      await expectStepUpRequired(
        requireStepUp(OWNER, {
          action: "change-password",
          now: T_PLUS_9MIN,
        })
      )
    }
  )

  it("a proof for one action does not unlock another action", async () => {
    await verifyStepUp(OWNER, PASSWORD, {
      action: "change-password",
      now: T,
    })
    await expectStepUpRequired(
      requireStepUp(OWNER, { action: "change-email", now: T_PLUS_9MIN })
    )
    // …and the action-less (legacy admin) gate does not accept an
    // action-bound row either.
    await expectStepUpRequired(requireStepUp(OWNER, { now: T_PLUS_9MIN }))
  })

  it("an unbound (legacy admin) proof still works for the admin actions", async () => {
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    const result = await requireStepUp(OWNER, { now: T_PLUS_9MIN })
    expect(result).toEqual({
      verifiedUntil: new Date(T.getTime() + 10 * 60_000),
    })
  })

  it("findStepUpVerification reads without consuming; consume is atomic", async () => {
    await verifyStepUp(OWNER, PASSWORD, {
      action: "change-email",
      now: T,
    })
    const found = await findStepUpVerification(
      "admin-1",
      "change-email",
      T_PLUS_9MIN
    )
    expect(found).not.toBeNull()
    // Still unconsumed: a second read finds the same row.
    expect(
      await findStepUpVerification("admin-1", "change-email", T_PLUS_9MIN)
    ).not.toBeNull()
    expect(await consumeStepUpVerification(found!.id, T_PLUS_9MIN)).toBe(true)
    // Second consume of the same row fails — the race loser gets false.
    expect(await consumeStepUpVerification(found!.id, T_PLUS_9MIN)).toBe(false)
    expect(
      await findStepUpVerification("admin-1", "change-email", T_PLUS_9MIN)
    ).toBeNull()
  })
})

describe("pruneStepUpVerifications (DB-053)", () => {
  it("removes expired and consumed rows, keeps usable ones", async () => {
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    // A second, already-expired row (verified long ago).
    verifications.push({
      id: "sv-old",
      userId: "admin-1",
      action: null,
      verifiedAt: new Date(T.getTime() - 60 * 60_000),
      expiresAt: new Date(T.getTime() - 50 * 60_000),
      consumedAt: null,
    })
    // Consume the fresh row, then prune: requireStepUp already
    // pruned the expired row on its way through, so the explicit
    // prune removes only the consumed row.
    await requireStepUp(OWNER, { now: T_PLUS_9MIN })
    expect(await pruneStepUpVerifications(T_PLUS_9MIN)).toBe(1)
    expect(verifications).toHaveLength(0)
    // A fresh usable row survives a prune.
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    expect(await pruneStepUpVerifications(T_PLUS_9MIN)).toBe(0)
    expect(verifications).toHaveLength(1)
  })

  it("verifyStepUp prunes spent rows on the way through", async () => {
    verifications.push({
      id: "sv-old",
      userId: "admin-1",
      action: null,
      verifiedAt: new Date(T.getTime() - 60 * 60_000),
      expiresAt: new Date(T.getTime() - 50 * 60_000),
      consumedAt: null,
    })
    await verifyStepUp(OWNER, PASSWORD, { now: T })
    expect(verifications).toHaveLength(1)
    expect(verifications[0].id).not.toBe("sv-old")
  })
})

describe("verifyStepUp account status (SRC-319 secondary)", () => {
  it("a suspended user cannot mint a proof, even with the right password", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      ...TARGET,
      status: "SUSPENDED",
    })
    await expect(
      verifyStepUp(OWNER, PASSWORD, { now: T })
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("suspended"),
    })
    expect(mockDb.stepUpVerification.create).not.toHaveBeenCalled()
  })
})

describe("step-up enforcement on the five actions", () => {
  it("disableUser refuses without verification and never touches the user row", async () => {
    await expectStepUpRequired(
      disableUser(OWNER, "user-2", { reason: "Abuse." })
    )
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("setAdminRole refuses without verification and never touches the user row", async () => {
    await expectStepUpRequired(
      setAdminRole(OWNER, "user-2", { adminRole: "SUPPORT" })
    )
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("reviewDeletionRequest APPROVED refuses without verification", async () => {
    await expectStepUpRequired(
      reviewDeletionRequest(OWNER, "req-1", {
        decision: "APPROVED",
        reason: "Confirmed.",
      })
    )
    expect(mockDb.deletionRequest.update).not.toHaveBeenCalled()
  })

  it("reviewDeletionRequest REJECTED needs no step-up", async () => {
    const result = await reviewDeletionRequest(OWNER, "req-1", {
      decision: "REJECTED",
      reason: "Not eligible.",
    })
    expect(result.status).toBe("REJECTED")
    expect(mockDb.deletionRequest.update).toHaveBeenCalledTimes(1)
    expect(mockDb.stepUpVerification.findFirst).not.toHaveBeenCalled()
  })

  it("executeErasure refuses without verification and never runs the transaction", async () => {
    mockDb.deletionRequest.findUnique.mockResolvedValue({
      id: "req-1",
      userId: "user-2",
      status: "APPROVED",
      user: {
        id: "user-2",
        name: "User",
        email: "user@example.com",
        platformRole: "PLATFORM_USER",
        status: "ACTIVE",
        deletionCompletedAt: null,
      },
    })
    await expectStepUpRequired(
      executeErasure(OWNER, "req-1", { reason: "Confirmed." })
    )
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("revokeMcpKey refuses without verification and never revokes", async () => {
    await expectStepUpRequired(revokeMcpKey(OWNER, "key-1", "Leaked."))
    expect(mockDb.apiKey.update).not.toHaveBeenCalled()
  })

  it("setMcpSettings (kill-switch) refuses without verification and never writes", async () => {
    await expectStepUpRequired(
      setMcpSettings(OWNER, { globalEnabled: false, reason: "Incident." })
    )
    expect(mockDb.mcpSettings.upsert).not.toHaveBeenCalled()
  })

  it(
    "a verified admin passes the gate: disableUser reaches the write",
    // TST-010: real-time scrypt verify; raised timeout for slow runs.
    { timeout: 30_000 },
    async () => {
      // Verify at the real current time: requireStepUp reads the wall
      // clock, so a fixed test time would go stale.
      await verifyStepUp(OWNER, PASSWORD, { now: new Date() })
      mockDb.user.update.mockResolvedValue({
        id: "user-2",
        status: "DISABLED",
      })
      const updated = await disableUser(OWNER, "user-2", { reason: "Abuse." })
      expect(mockDb.user.update).toHaveBeenCalledTimes(1)
      expect(updated.status).toBe("DISABLED")
    }
  )
})
