// Seven admin pages, Phase C — Jobs, Worker A (plan §3.6, Q8).
// CronRun writer + retention + list/getLatest/manual-run services +
// the worker's failed-poll-only record. No test hits the real DB, a
// real provider, or the network: the service tests use the same
// mocked-Prisma pattern as tests/seven-pages-phase-b-worker-b.test.ts
// (spread the real module, mock only `db`), the worker tests mock
// `@sendcms/cron`'s record function the way tests/email-worker.test.ts
// mocks the step services.
//
// TIME: one test renders a clock time, and it pins `timeZone:
// "America/Los_Angeles"` explicitly in the formatter — `process.env.TZ`
// in vitest.config does NOT work. Every other time assertion compares
// ISO strings or Dates, never a locale-rendered clock time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@sendcms/shared"
import type { processEmailOutbox } from "@sendcms/notifications"
import type {
  rescoreNewSubmissions,
  sendDueDigests,
} from "@sendcms/submissions"
import type { expireSubscriptions } from "@sendcms/plans"
import type { AdminSession } from "@sendcms/auth"
import { CronJobName, CronRunStatus, CronTrigger } from "@sendcms/database"

const mockProcessOutbox = vi.hoisted(() =>
  vi.fn<typeof processEmailOutbox>(async () => ({
    processed: 2,
    sent: 1,
    failed: 0,
    skipped: 1,
  }))
)
const mockRescore = vi.hoisted(() =>
  vi.fn<typeof rescoreNewSubmissions>(async () => ({
    checked: 3,
    markedSpam: 1,
    skipped: 5,
  }))
)
const mockDigest = vi.hoisted(() =>
  vi.fn<typeof sendDueDigests>(async () => ({ sent: 2, skipped: 7 }))
)
const mockExpire = vi.hoisted(() =>
  vi.fn<typeof expireSubscriptions>(async () => [
    {
      subscriptionId: "s1",
      userId: "u1",
      fromStatus: "ACTIVE",
      toStatus: "EXPIRED",
      dryRun: false,
    },
    {
      subscriptionId: "s2",
      userId: "u1",
      fromStatus: "ACTIVE",
      toStatus: "CANCELED",
      dryRun: false,
    },
  ])
)
const mockEnqueue = vi.hoisted(() => vi.fn(async () => 1))
const mockLogAudit = vi.hoisted(() => vi.fn(async () => undefined))
const mockRequireStepUp = vi.hoisted(() => vi.fn(async () => undefined))
const mockRecordWorkerFailedPoll = vi.hoisted(() =>
  vi.fn(async () => ({ id: "run-worker-1" }))
)
// PRF-018 (Wave 11): the worker also imports the heartbeat ping from
// the cron barrel — the mock must export it or the poll throws.
const mockPingCronHeartbeat = vi.hoisted(() => vi.fn(async () => undefined))
const mockQueueDepth = vi.hoisted(() =>
  vi.fn(async () => ({
    pending: 0,
    pendingDue: 0,
    sending: 0,
    failed: 0,
    stuckSendingAgeMinutes: null,
  }))
)
const mockRecentFailed = vi.hoisted(() => vi.fn(async () => []))

type StoredRun = {
  id: string
  jobName: string
  trigger: string
  triggeredById: string | null
  status: string
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
  steps: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    runs: new Map<string, StoredRun>(),
    seq: 1,
  }

  function filterRuns(where?: Record<string, unknown>): StoredRun[] {
    const w = (where ?? {}) as {
      jobName?: string
      status?: string
      trigger?: string
    }
    return [...store.runs.values()].filter(
      (r) =>
        (w.jobName === undefined || r.jobName === w.jobName) &&
        (w.status === undefined || r.status === w.status) &&
        (w.trigger === undefined || r.trigger === w.trigger)
    )
  }

  function sortRuns(
    rows: StoredRun[],
    orderBy?: { createdAt?: "asc" | "desc" }
  ): StoredRun[] {
    if (!orderBy?.createdAt) return rows
    const dir = orderBy.createdAt === "desc" ? -1 : 1
    return [...rows].sort(
      (a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime())
    )
  }

  const mockDb = {
    cronRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: StoredRun = {
          id: `run-${store.seq++}`,
          jobName: "EMAIL_OUTBOX",
          trigger: "VERCEL_CRON",
          triggeredById: null,
          status: "RUNNING",
          startedAt: new Date(),
          finishedAt: null,
          durationMs: null,
          steps: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as Partial<StoredRun>),
        }
        store.runs.set(row.id, row)
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
          const row = store.runs.get(where.id)
          if (!row) throw new Error(`CronRun ${where.id} not found`)
          Object.assign(row, data, { updatedAt: new Date() })
          return row
        }
      ),
      deleteMany: vi.fn(
        async ({ where }: { where?: { createdAt?: { lt?: Date } } }) => {
          const cutoff = where?.createdAt?.lt
          let count = 0
          for (const [id, row] of store.runs) {
            if (cutoff !== undefined && row.createdAt < cutoff) {
              store.runs.delete(id)
              count++
            }
          }
          return { count }
        }
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          filterRuns(where).length
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
        }) => {
          const rows = sortRuns(filterRuns(where), orderBy)
          return take === undefined
            ? rows.slice(skip)
            : rows.slice(skip, skip + take)
        }
      ),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: Record<string, unknown>
          orderBy?: { createdAt?: "asc" | "desc" }
        }) => sortRuns(filterRuns(where), orderBy)[0] ?? null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.runs.get(where.id) ?? null
      }),
    },
    submission: {
      findMany: vi.fn(async () => []),
    },
    emailJob: {
      count: vi.fn(async () => 0),
    },
  }
  return { store, mockDb }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
  enqueueSubmissionNotifications: mockEnqueue,
}))
vi.mock("@sendcms/submissions", () => ({
  rescoreNewSubmissions: mockRescore,
  sendDueDigests: mockDigest,
}))
vi.mock("@sendcms/plans", () => ({
  expireSubscriptions: mockExpire,
}))
vi.mock("@sendcms/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/security")>()
  return { ...actual, logAudit: mockLogAudit, requireStepUp: mockRequireStepUp }
})
// The worker imports the cron barrel for its failed-poll record; the
// service tests below import the real service through its relative
// source path, so this mock only affects the worker tests.
vi.mock("@sendcms/cron", () => ({
  recordWorkerFailedPoll: mockRecordWorkerFailedPoll,
  pingCronHeartbeat: mockPingCronHeartbeat,
}))
vi.mock("@sendcms/platform-ops", () => ({
  getEmailQueueDepth: mockQueueDepth,
  getRecentFailedEmailJobs: mockRecentFailed,
}))
vi.mock("@sendcms/queue", () => ({
  STALE_CLAIM_LEASE_MINUTES: 10,
}))

// The service under test, imported through its source path so the
// mocked "@sendcms/cron" barrel above only affects the worker tests.
import {
  CRON_RUN_RETENTION_DAYS,
  buildCronRunSteps,
  deriveCronRunStatus,
  emptyCronRunSteps,
  getLatestCronRun,
  getLastCronRun,
  listCronRuns,
  runEmailOutboxCron,
  runManualEmailOutboxCron,
} from "../packages/modules/cron/src/service"
import {
  CronRunsQuerySchema,
  CronJobNameSchema,
  CronRunStatusSchema,
  CronTriggerSchema,
} from "../packages/modules/cron/src/validators"
import { createEmailWorker } from "@sendcms/email-worker/worker"

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
const plainUserActor = () =>
  makeActor({
    id: "user-1",
    platformRole: "PLATFORM_USER",
    adminRole: null,
  })

const NOW = new Date("2026-11-26T12:00:00Z")
const at = (iso: string) => new Date(iso)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

function seedRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const id = overrides.id ?? `run-${store.seq++}`
  const row: StoredRun = {
    id,
    jobName: "EMAIL_OUTBOX",
    trigger: "VERCEL_CRON",
    triggeredById: null,
    status: "SUCCESS",
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 1234,
    steps: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
  store.runs.set(id, row)
  return row
}

let worker: ReturnType<typeof createEmailWorker> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  store.runs.clear()
  store.seq = 1
  mockProcessOutbox.mockResolvedValue({
    processed: 2,
    sent: 1,
    failed: 0,
    skipped: 1,
  })
  mockRescore.mockResolvedValue({ checked: 3, markedSpam: 1, skipped: 5 })
  mockDigest.mockResolvedValue({ sent: 2, skipped: 7 })
  mockExpire.mockResolvedValue([
    {
      subscriptionId: "s1",
      userId: "u1",
      fromStatus: "ACTIVE",
      toStatus: "EXPIRED",
      dryRun: false,
    },
    {
      subscriptionId: "s2",
      userId: "u1",
      fromStatus: "ACTIVE",
      toStatus: "CANCELED",
      dryRun: false,
    },
  ])
  mockQueueDepth.mockResolvedValue({
    pending: 0,
    pendingDue: 0,
    sending: 0,
    failed: 0,
    stuckSendingAgeMinutes: null,
  })
  mockRecentFailed.mockResolvedValue([])
  mockRecordWorkerFailedPoll.mockResolvedValue({ id: "run-worker-1" })
})

afterEach(async () => {
  if (worker) {
    await worker.stop()
    worker = null
  }
  vi.clearAllMocks()
})

// ─── CronRun writer — success ───────────────────────────────────────────

describe("runEmailOutboxCron — CronRun writer (success)", () => {
  it("inserts a RUNNING row at start and finishes it SUCCESS with steps + durationMs", async () => {
    const result = await runEmailOutboxCron()
    expect(result.processed).toBe(2)

    expect(mockDb.cronRun.create).toHaveBeenCalledTimes(1)
    expect(mockDb.cronRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobName: "EMAIL_OUTBOX",
          trigger: "VERCEL_CRON",
          triggeredById: null,
          status: "RUNNING",
          startedAt: expect.any(Date),
        }),
      })
    )
    expect(mockDb.cronRun.update).toHaveBeenCalledTimes(1)
    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as {
      where: { id: string }
      data: {
        status: string
        steps: Record<string, { processed: number; errors: string[] }>
        finishedAt: Date
        durationMs: number
      }
    }
    expect(updateArg.where.id).toBe("run-1")
    expect(updateArg.data.status).toBe("SUCCESS")
    expect(updateArg.data.finishedAt).toBeInstanceOf(Date)
    expect(typeof updateArg.data.durationMs).toBe("number")
    expect(updateArg.data.durationMs).toBeGreaterThanOrEqual(0)
    // Per-step numbers are the ones the function already returns.
    expect(updateArg.data.steps.outbox).toEqual({
      processed: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
      errors: [],
    })
    expect(updateArg.data.steps.rescore).toEqual({
      processed: 3,
      sent: 1,
      failed: 0,
      skipped: 5,
      errors: [],
    })
    expect(updateArg.data.steps.digest).toEqual({
      processed: 9,
      sent: 2,
      failed: 0,
      skipped: 7,
      errors: [],
    })
    expect(updateArg.data.steps.expiry).toEqual({
      processed: 2,
      sent: 1,
      failed: 0,
      skipped: 0,
      errors: [],
    })
    expect(updateArg.data.steps.reconcile).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    })
    // The stored row reads back finished.
    const stored = store.runs.get("run-1")
    expect(stored?.status).toBe("SUCCESS")
    expect(stored?.finishedAt).toBeInstanceOf(Date)
    // getLastCronRun (in-memory) still works alongside the table.
    expect(getLastCronRun()).toEqual(result)
  })

  it("runs the retention prune inside the cron run (Q8)", async () => {
    await runEmailOutboxCron()
    expect(mockDb.cronRun.deleteMany).toHaveBeenCalledTimes(1)
    const arg = mockDb.cronRun.deleteMany.mock.calls[0][0] as {
      where: { createdAt: { lt: Date } }
    }
    const cutoff = arg.where.createdAt.lt.getTime()
    const expected = Date.now() - CRON_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000
    // The cutoff is now minus exactly the retention window.
    expect(Math.abs(cutoff - expected)).toBeLessThan(60_000)
  })
})

// ─── CronRun writer — partial ───────────────────────────────────────────

describe("runEmailOutboxCron — CronRun writer (partial)", () => {
  it("is PARTIAL when a step throws, with the error on that step", async () => {
    mockProcessOutbox.mockRejectedValueOnce(new Error("db down"))
    const result = await runEmailOutboxCron()
    expect(result.outboxError).toBe("db down")

    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as unknown as {
      data: {
        status: string
        steps: Record<string, { errors: string[] }>
      }
    }
    expect(updateArg.data.status).toBe("PARTIAL")
    expect(updateArg.data.steps.outbox.errors).toEqual(["db down"])
    expect(updateArg.data.steps.rescore.errors).toEqual([])
  })

  it("is PARTIAL when outbox jobs failed, even with no step error", async () => {
    mockProcessOutbox.mockResolvedValue({
      processed: 3,
      sent: 1,
      failed: 2,
      skipped: 0,
    })
    await runEmailOutboxCron()
    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as unknown as {
      data: {
        status: string
        steps: Record<string, { failed: number }>
      }
    }
    expect(updateArg.data.status).toBe("PARTIAL")
    expect(updateArg.data.steps.outbox.failed).toBe(2)
  })

  it("stays SUCCESS when jobs were only skipped by the other processor (EML-038)", async () => {
    mockProcessOutbox.mockResolvedValue({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 25,
    })
    const result = await runEmailOutboxCron()
    expect(result.skipped).toBe(25)
    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as unknown as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("SUCCESS")
  })

  it("is FAILED when every step errors", async () => {
    mockProcessOutbox.mockRejectedValueOnce(new Error("db down"))
    mockRescore.mockRejectedValueOnce(new Error("ai down"))
    mockDigest.mockRejectedValueOnce(new Error("ai down"))
    mockExpire.mockRejectedValueOnce(new Error("db down"))
    // The reconciler's findMany throws: its step errors too.
    mockDb.submission.findMany.mockRejectedValueOnce(new Error("db down"))
    await runEmailOutboxCron()
    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as unknown as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("FAILED")
  })
})

// ─── CronRun writer — failure (throw) ───────────────────────────────────

describe("runEmailOutboxCron — CronRun writer (failure)", () => {
  it("still writes a FAILED row when the run itself throws, then rethrows", async () => {
    // A step returning a malformed value breaks the aggregation
    // (expired.filter) — the run throws outside the per-step
    // isolation, so the catch path must finish the row as FAILED.
    mockExpire.mockResolvedValue({} as unknown as never)
    await expect(runEmailOutboxCron()).rejects.toThrow()
    expect(mockDb.cronRun.create).toHaveBeenCalledTimes(1)
    expect(mockDb.cronRun.update).toHaveBeenCalledTimes(1)
    const updateArg = mockDb.cronRun.update.mock.calls[0][0] as unknown as {
      data: {
        status: string
        steps: Record<string, { errors: string[] }>
        finishedAt: Date
        durationMs: number
      }
    }
    expect(updateArg.data.status).toBe("FAILED")
    expect(updateArg.data.finishedAt).toBeInstanceOf(Date)
    expect(typeof updateArg.data.durationMs).toBe("number")
    expect(updateArg.data.steps.outbox.errors).toHaveLength(1)
    expect(updateArg.data.steps.outbox.errors[0]).toMatch(/filter/)
    expect(store.runs.get("run-1")?.status).toBe("FAILED")
  })

  it("still runs the steps when the writer insert fails (best-effort)", async () => {
    mockDb.cronRun.create.mockRejectedValueOnce(new Error("db down"))
    const result = await runEmailOutboxCron()
    expect(result.processed).toBe(2)
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    // No row exists, so there is no finish update and no prune crash.
    expect(mockDb.cronRun.update).not.toHaveBeenCalled()
  })
})

// ─── Status + steps helpers ─────────────────────────────────────────────

describe("deriveCronRunStatus / buildCronRunSteps / emptyCronRunSteps", () => {
  const base = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    outboxError: null,
    rescored: 0,
    markedSpam: 0,
    rescoreSkipped: 0,
    rescoreError: null,
    digests: 0,
    digestSkipped: 0,
    digestError: null,
    subscriptionsExpired: 0,
    subscriptionsCanceled: 0,
    expiryError: null,
    reconciled: 0,
    reconcileJobsCreated: 0,
    reconcileError: null,
    durationMs: 10,
    runAt: "2026-11-26T12:00:00Z",
  } as const

  it("SUCCESS with no errors and no failed jobs", () => {
    expect(deriveCronRunStatus({ ...base })).toBe("SUCCESS")
  })

  it("PARTIAL with one step error, FAILED with all five", () => {
    expect(deriveCronRunStatus({ ...base, outboxError: "db down" })).toBe(
      "PARTIAL"
    )
    expect(
      deriveCronRunStatus({
        ...base,
        outboxError: "a",
        rescoreError: "b",
        digestError: "c",
        expiryError: "d",
        reconcileError: "e",
      })
    ).toBe("FAILED")
  })

  it("PARTIAL with failed jobs and no step error", () => {
    expect(deriveCronRunStatus({ ...base, processed: 1, failed: 1 })).toBe(
      "PARTIAL"
    )
  })

  it("buildCronRunSteps maps every step's numbers, errors as arrays", () => {
    const steps = buildCronRunSteps({
      ...base,
      processed: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
      rescored: 3,
      markedSpam: 1,
      rescoreSkipped: 5,
      digests: 2,
      digestSkipped: 7,
      subscriptionsExpired: 1,
      subscriptionsCanceled: 1,
      reconciled: 1,
      reconcileJobsCreated: 2,
      digestError: "ai down",
    })
    expect(steps.digest).toEqual({
      processed: 9,
      sent: 2,
      failed: 0,
      skipped: 7,
      errors: ["ai down"],
    })
    expect(steps.expiry).toEqual({
      processed: 2,
      sent: 1,
      failed: 0,
      skipped: 0,
      errors: [],
    })
    expect(steps.reconcile).toEqual({
      processed: 1,
      sent: 2,
      failed: 0,
      skipped: 0,
      errors: [],
    })
  })

  it("emptyCronRunSteps is all zeros with no errors", () => {
    const steps = emptyCronRunSteps()
    for (const step of Object.values(steps)) {
      expect(step).toEqual({
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        errors: [],
      })
    }
  })
})

// ─── Retention ──────────────────────────────────────────────────────────

describe("retention — 90 days, CronRun rows only (Q8)", () => {
  it("deletes only rows older than 90 days", async () => {
    // Dates are relative to the REAL now: the prune cutoff is computed
    // from the wall clock, so anchoring the seeds to the file's fixed
    // NOW (2026-11-26) makes the 89-day edge row expire the day after
    // the test was written. Anchor to real now instead.
    const realNow = new Date()
    const realDaysAgo = (n: number) =>
      new Date(realNow.getTime() - n * 24 * 60 * 60 * 1000)
    const old = seedRun({ id: "run-old", createdAt: realDaysAgo(91) })
    const edge = seedRun({ id: "run-edge", createdAt: realDaysAgo(89) })
    const fresh = seedRun({ id: "run-fresh", createdAt: realNow })
    await runEmailOutboxCron()
    expect(store.runs.has(old.id)).toBe(false)
    expect(store.runs.has(edge.id)).toBe(true)
    expect(store.runs.has(fresh.id)).toBe(true)
    // The run's own new row survives the prune it just ran.
    expect(store.runs.has("run-1")).toBe(true)
  })

  it("the retention window is 90 days", () => {
    expect(CRON_RUN_RETENTION_DAYS).toBe(90)
  })
})

// ─── listCronRuns ───────────────────────────────────────────────────────

describe("listCronRuns — filters + pagination", () => {
  beforeEach(() => {
    seedRun({
      id: "r1",
      trigger: "VERCEL_CRON",
      status: "SUCCESS",
      createdAt: at("2026-11-26T10:00:00Z"),
    })
    seedRun({
      id: "r2",
      trigger: "MANUAL",
      status: "SUCCESS",
      createdAt: at("2026-11-26T11:00:00Z"),
    })
    seedRun({
      id: "r3",
      trigger: "WORKER",
      status: "FAILED",
      createdAt: at("2026-11-26T12:00:00Z"),
    })
    seedRun({
      id: "r4",
      trigger: "VERCEL_CRON",
      status: "PARTIAL",
      createdAt: at("2026-11-25T12:00:00Z"),
    })
    seedRun({
      id: "r5",
      trigger: "MANUAL",
      status: "FAILED",
      createdAt: at("2026-11-24T12:00:00Z"),
    })
  })

  it("returns newest first with total + totalPages", async () => {
    const page = await listCronRuns(ownerActor(), { page: 1, perPage: 20 })
    expect(page.total).toBe(5)
    expect(page.totalPages).toBe(1)
    expect(page.page).toBe(1)
    expect(page.perPage).toBe(20)
    expect(page.runs.map((r) => r.id)).toEqual(["r3", "r2", "r1", "r4", "r5"])
  })

  it("paginates: page 2 of 2-per-page is the next slice", async () => {
    const first = await listCronRuns(ownerActor(), { page: 1, perPage: 2 })
    expect(first.total).toBe(5)
    expect(first.totalPages).toBe(3)
    expect(first.runs.map((r) => r.id)).toEqual(["r3", "r2"])
    const second = await listCronRuns(ownerActor(), { page: 2, perPage: 2 })
    expect(second.runs.map((r) => r.id)).toEqual(["r1", "r4"])
    const third = await listCronRuns(ownerActor(), { page: 3, perPage: 2 })
    expect(third.runs.map((r) => r.id)).toEqual(["r5"])
  })

  it("filters by status", async () => {
    const page = await listCronRuns(ownerActor(), {
      page: 1,
      perPage: 20,
      status: "FAILED",
    })
    expect(page.total).toBe(2)
    expect(page.runs.map((r) => r.id)).toEqual(["r3", "r5"])
  })

  it("filters by trigger", async () => {
    const page = await listCronRuns(ownerActor(), {
      page: 1,
      perPage: 20,
      trigger: "MANUAL",
    })
    expect(page.total).toBe(2)
    expect(page.runs.map((r) => r.id)).toEqual(["r2", "r5"])
  })

  it("filters by jobName", async () => {
    const page = await listCronRuns(ownerActor(), {
      page: 1,
      perPage: 20,
      jobName: "EMAIL_OUTBOX",
    })
    expect(page.total).toBe(5)
  })

  it("combines filters", async () => {
    const page = await listCronRuns(ownerActor(), {
      page: 1,
      perPage: 20,
      trigger: "MANUAL",
      status: "FAILED",
    })
    expect(page.total).toBe(1)
    expect(page.runs[0].id).toBe("r5")
  })

  it("an empty filter result is an empty page, not an error", async () => {
    const page = await listCronRuns(ownerActor(), {
      page: 1,
      perPage: 20,
      status: "RUNNING",
    })
    expect(page.total).toBe(0)
    expect(page.runs).toEqual([])
    expect(page.totalPages).toBe(1)
  })

  it("a plain user may not read the list (no VIEW_JOBS), SUPPORT may", async () => {
    await expect(
      listCronRuns(plainUserActor(), { page: 1, perPage: 20 })
    ).rejects.toMatchObject({ status: 403 })
    expect(mockDb.cronRun.count).not.toHaveBeenCalled()
    expect(mockDb.cronRun.findMany).not.toHaveBeenCalled()
    const page = await listCronRuns(supportActor(), { page: 1, perPage: 20 })
    expect(page.total).toBe(5)
  })
})

// ─── getLatestCronRun ───────────────────────────────────────────────────

describe("getLatestCronRun — newest-first", () => {
  it("returns the newest row", async () => {
    seedRun({ id: "r-old", createdAt: at("2026-11-25T12:00:00Z") })
    const newest = seedRun({ id: "r-new", createdAt: NOW })
    const row = await getLatestCronRun(ownerActor())
    expect(row?.id).toBe(newest.id)
  })

  it("returns null when no run has ever been recorded", async () => {
    await expect(getLatestCronRun(ownerActor())).resolves.toBeNull()
  })

  it("SUPPORT may read it (VIEW_JOBS) but a plain user may not", async () => {
    seedRun({ id: "r1", createdAt: NOW })
    expect((await getLatestCronRun(supportActor()))?.id).toBe("r1")
    await expect(getLatestCronRun(plainUserActor())).rejects.toMatchObject({
      status: 403,
    })
  })

  it("renders the newest run's start time in a pinned timeZone", async () => {
    // 2026-11-26T12:00:00Z is 04:00 in America/Los_Angeles (PST).
    // The timeZone is pinned explicitly here — process.env.TZ in
    // vitest.config does NOT work.
    seedRun({ id: "r1", createdAt: NOW, startedAt: NOW })
    const row = await getLatestCronRun(ownerActor())
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(row!.startedAt)
    expect(rendered).toBe("04:00")
  })
})

// ─── runManualEmailOutboxCron ───────────────────────────────────────────

describe("runManualEmailOutboxCron — manual trigger", () => {
  it("creates a MANUAL row with triggeredById, runs the same steps, audits", async () => {
    const run = await runManualEmailOutboxCron(ownerActor())
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    expect(mockDb.cronRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobName: "EMAIL_OUTBOX",
          trigger: "MANUAL",
          triggeredById: "owner-1",
          status: "RUNNING",
        }),
      })
    )
    expect(run.id).toBe("run-1")
    expect(run.trigger).toBe("MANUAL")
    expect(run.triggeredById).toBe("owner-1")
    expect(run.status).toBe("SUCCESS")
    expect(typeof run.durationMs).toBe("number")
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        action: "CREATE",
        resourceType: "SETTINGS",
        resourceId: "run-1",
        detail: expect.objectContaining({
          event: "manual-cron-run",
          jobName: "EMAIL_OUTBOX",
          trigger: "MANUAL",
          status: "SUCCESS",
        }),
      })
    )
  })

  it("MANAGER may not trigger a manual run (MANAGE_JOBS, Q9)", async () => {
    await expect(
      runManualEmailOutboxCron(managerActor())
    ).rejects.toMatchObject({ status: 403 })
    expect(mockProcessOutbox).not.toHaveBeenCalled()
    expect(mockDb.cronRun.create).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("SUPPORT may not trigger a manual run", async () => {
    await expect(
      runManualEmailOutboxCron(supportActor())
    ).rejects.toMatchObject({ status: 403 })
    expect(mockProcessOutbox).not.toHaveBeenCalled()
  })

  it("SUPER_ADMIN may trigger a manual run", async () => {
    const actor = makeActor({
      id: "sa-1",
      platformRole: "PLATFORM_USER",
      adminRole: "SUPER_ADMIN",
    })
    const run = await runManualEmailOutboxCron(actor)
    expect(run.triggeredById).toBe("sa-1")
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
  })

  it("refuses when step-up is missing and runs nothing (step-up in the service, Phase B pattern)", async () => {
    mockRequireStepUp.mockRejectedValueOnce(
      new ApiError("Step-up verification required.", 403)
    )
    await expect(runManualEmailOutboxCron(ownerActor())).rejects.toMatchObject({
      status: 403,
    })
    // Guards first, step-up last: the capability check passed, the
    // step-up failed, and the run never started.
    expect(mockProcessOutbox).not.toHaveBeenCalled()
    expect(mockDb.cronRun.create).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("returns 503 when the run completed but its record could not be written", async () => {
    mockDb.cronRun.create.mockRejectedValueOnce(new Error("db down"))
    await expect(runManualEmailOutboxCron(ownerActor())).rejects.toMatchObject({
      status: 503,
    })
    // The steps still ran — only the record is missing.
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).not.toHaveBeenCalled()
  })
})

// ─── Worker — failed polls only (Q8) ────────────────────────────────────

describe("email worker — CronRun row only on failed polls (Q8)", () => {
  it("writes a failed-poll row when the outbox drain throws", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    mockProcessOutbox.mockRejectedValueOnce(new Error("db down"))
    const run = await worker.runOnce()
    expect(run).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      rescored: 0,
      markedSpam: 0,
      rescoreSkipped: 0,
      digests: 0,
      digestSkipped: 0,
      expired: 0,
      canceled: 0,
    })
    expect(mockRecordWorkerFailedPoll).toHaveBeenCalledTimes(1)
    expect(mockRecordWorkerFailedPoll).toHaveBeenCalledWith(
      expect.objectContaining({ error: "db down" })
    )
    const health = worker.getHealth()
    expect(health.consecutiveFailedPolls).toBe(1)
    expect(health.lastError).toBe("db down")
  })

  it("writes nothing on a successful poll", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    const run = await worker.runOnce()
    expect(run.processed).toBe(2)
    expect(run.sent).toBe(1)
    expect(mockRecordWorkerFailedPoll).not.toHaveBeenCalled()
    expect(worker.getHealth().consecutiveFailedPolls).toBe(0)
  })

  it("writes nothing when the poll succeeds but jobs failed (poll-level success)", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    mockProcessOutbox.mockResolvedValue({
      processed: 2,
      sent: 0,
      failed: 2,
      skipped: 0,
    })
    const run = await worker.runOnce()
    expect(run.failed).toBe(2)
    expect(mockRecordWorkerFailedPoll).not.toHaveBeenCalled()
    expect(worker.getHealth().consecutiveFailedPolls).toBe(0)
  })
})

// ─── Validators ────────────────────────────────────────────────────────

describe("CronRuns validators", () => {
  it("defaults the list query to page 1, 20 per page", () => {
    expect(CronRunsQuerySchema.parse({})).toEqual({
      page: 1,
      perPage: 20,
    })
  })

  it("coerces query-string page/perPage", () => {
    expect(CronRunsQuerySchema.parse({ page: "2", perPage: "5" })).toEqual({
      page: 2,
      perPage: 5,
    })
  })

  it("rejects an unknown jobName / status / trigger", () => {
    expect(CronRunsQuerySchema.safeParse({ jobName: "DIGESTS" }).success).toBe(
      false
    )
    expect(CronRunsQuerySchema.safeParse({ status: "DONE" }).success).toBe(
      false
    )
    expect(
      CronRunsQuerySchema.safeParse({ trigger: "SCHEDULED" }).success
    ).toBe(false)
  })

  it("accepts every valid enum value", () => {
    expect(
      CronRunsQuerySchema.safeParse({
        jobName: "EMAIL_OUTBOX",
        status: "PARTIAL",
        trigger: "WORKER",
      }).success
    ).toBe(true)
  })

  it("the validator enum lists match the Prisma enums exactly (drift guard)", () => {
    expect([...CronJobNameSchema.options].sort()).toEqual(
      Object.values(CronJobName).sort()
    )
    expect([...CronRunStatusSchema.options].sort()).toEqual(
      Object.values(CronRunStatus).sort()
    )
    expect([...CronTriggerSchema.options].sort()).toEqual(
      Object.values(CronTrigger).sort()
    )
  })
})
