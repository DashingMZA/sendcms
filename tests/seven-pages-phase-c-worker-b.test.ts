// Phase C Worker B — Jobs capabilities + admin email-job variants +
// admin jobs API routes (plan §3.6, Q9).
// No test hits the real DB, a real provider, or the network: the
// service tests use the same mocked-Prisma pattern as
// tests/seven-pages-phase-b-worker-b.test.ts, the route tests the
// same mocked-gate pattern as
// tests/seven-pages-phase-a-worker-c-route.test.ts, and the wiring
// tests are static file reads in the Worker A style.
//
// STREAM A (landed in the working tree while this stream ran):
// `listCronRuns` / `runManualEmailOutboxCron` + `CronRunsQuerySchema`
// now exist in @sendcms/cron, so the cron routes import them
// directly — no stub. The cron route tests mock only the two
// service functions and keep the REAL Zod schema (via
// importOriginal), so bad query values still 422 for real. The Jobs
// admin PAGE (sidebar item, jobs.json, load.ts entry) belongs to
// the page stream, not this file.
//
// TIME: no test asserts a locale-rendered clock time. Claim ages
// are minute counts computed from Date.now() at seed time (5 vs 11
// minutes around the 10-minute lease), and the requeued
// nextAttemptAt is asserted as a Date within a 5 s window of
// Date.now() — no locale formatting, so no timeZone pinning is
// needed in an assertion.
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { ApiError } from "@sendcms/api-client"
import { PLATFORM_ROUTE_CAPABILITY, adminCan } from "@sendcms/permissions"
import type { AdminSession } from "@sendcms/auth"

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
const plainUserActor = () =>
  makeActor({
    id: "user-1",
    platformRole: "PLATFORM_USER",
    adminRole: null,
  })

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

// ─── Mocks ────────────────────────────────────────────────────────────

const mockLogAudit = vi.hoisted(() =>
  vi.fn(async (...args: unknown[]) => {
    void args
    return undefined
  })
)
const mockRequireStepUp = vi.hoisted(() =>
  vi.fn(async () => ({ verifiedUntil: new Date("2026-11-26T13:00:00Z") }))
)

// Route-test mocks (Worker C pattern): the routes import the
// notifications barrel and the cron barrel, so both are mocked here;
// the service tests import the real service through its relative
// source path below.
const mockSession = { user: { id: "admin-1" } }
const mockRequireAdminApi = vi.hoisted(() => vi.fn(async () => mockSession))
const mockEnforceRateLimit = vi.hoisted(() =>
  vi.fn(async (): Promise<NextResponse | null> => null)
)
const mockListEmailJobsForAdmin = vi.hoisted(() =>
  vi.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    counts: { all: 0, pending: 0, sending: 0, sent: 0, failed: 0 },
  }))
)
const mockGetEmailJobForAdmin = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job-1" }))
)
const mockRequeueEmailJobForAdmin = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job-1", status: "PENDING" }))
)
const mockListCronRuns = vi.hoisted(() =>
  vi.fn(async () => ({
    runs: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalPages: 1,
  }))
)
const mockRunManualEmailOutboxCron = vi.hoisted(() =>
  vi.fn(async () => ({ status: "SUCCESS", processed: 0 }))
)

type StoredJob = {
  id: string
  type: string
  to: string
  subject: string
  status: "PENDING" | "SENDING" | "SENT" | "FAILED"
  attempts: number
  nextAttemptAt: Date | null
  claimedAt: Date | null
  lastError: string | null
  providerMessageId: string | null
  deliveryStatus: string | null
  deliveryUpdatedAt: Date | null
  payload: unknown
  createdAt: Date
  updatedAt: Date
  formId: string | null
  submissionId: string | null
  ownerId: string
  form: { name: string } | null
  owner: { name: string | null; email: string }
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    jobs: new Map<string, StoredJob>(),
    seq: 1,
  }

  function matchWhere(
    job: StoredJob,
    where?: Record<string, unknown>
  ): boolean {
    if (!where) return true
    if (where.status !== undefined && job.status !== where.status) return false
    if (where.type !== undefined && job.type !== where.type) return false
    if (where.ownerId !== undefined && job.ownerId !== where.ownerId)
      return false
    const owner = where.owner as
      | {
          OR?: Array<{
            email?: { contains?: string }
            name?: { contains?: string }
          }>
        }
      | undefined
    if (owner?.OR) {
      const hit = owner.OR.some((cond) => {
        const emailNeedle = cond.email?.contains?.toLowerCase()
        if (emailNeedle !== undefined)
          return job.owner.email.toLowerCase().includes(emailNeedle)
        const nameNeedle = cond.name?.contains?.toLowerCase()
        if (nameNeedle !== undefined)
          return (job.owner.name ?? "").toLowerCase().includes(nameNeedle)
        return false
      })
      if (!hit) return false
    }
    return true
  }

  function sorted(
    rows: StoredJob[],
    order?: { createdAt?: "asc" | "desc" }
  ): StoredJob[] {
    if (!order?.createdAt) return rows
    const dir = order.createdAt === "desc" ? -1 : 1
    return [...rows].sort(
      (a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime())
    )
  }

  const mockDb = {
    emailJob: {
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
          const rows = sorted(
            [...store.jobs.values()].filter((j) => matchWhere(j, where)),
            orderBy
          )
          return take === undefined
            ? rows.slice(skip)
            : rows.slice(skip, skip + take)
        }
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          store.jobs.get(where.id) ?? null
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          [...store.jobs.values()].filter((j) => matchWhere(j, where)).length
      ),
      groupBy: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        const byStatus = new Map<string, number>()
        for (const job of [...store.jobs.values()].filter((j) =>
          matchWhere(j, where)
        )) {
          byStatus.set(job.status, (byStatus.get(job.status) ?? 0) + 1)
        }
        return [...byStatus.entries()].map(([status, count]) => ({
          status,
          _count: count,
        }))
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Partial<StoredJob>
        }) => {
          const job = store.jobs.get(where.id)
          if (!job) throw new Error(`job ${where.id} not found in mock store`)
          const updated = { ...job, ...data }
          store.jobs.set(where.id, updated)
          return updated
        }
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
  return { ...actual, logAudit: mockLogAudit, requireStepUp: mockRequireStepUp }
})
vi.mock("@/lib/require-admin-api", () => ({
  requireAdminApi: mockRequireAdminApi,
}))
vi.mock("@/lib/rate-limit", () => ({
  enforceAdminApiRateLimit: mockEnforceRateLimit,
}))
vi.mock("@sendcms/notifications", () => ({
  listEmailJobsForAdmin: mockListEmailJobsForAdmin,
  getEmailJobForAdmin: mockGetEmailJobForAdmin,
  requeueEmailJobForAdmin: mockRequeueEmailJobForAdmin,
  // The real @sendcms/cron service (kept via importOriginal below)
  // imports these two from this barrel; they are never called in
  // this file, but the import must resolve.
  enqueueSubmissionNotifications: vi.fn(),
  processEmailOutbox: vi.fn(),
}))
vi.mock("@sendcms/cron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/cron")>()
  return {
    ...actual,
    listCronRuns: mockListCronRuns,
    runManualEmailOutboxCron: mockRunManualEmailOutboxCron,
  }
})

// The service under test, imported through its source path so the
// mocked "@sendcms/notifications" barrel above only affects the
// route tests.
import {
  getEmailJobForAdmin,
  listEmailJobsForAdmin,
  listEmailJobsForUser,
  requeueEmailJob,
  requeueEmailJobForAdmin,
} from "../packages/modules/notifications/src/service"
import { AdminEmailJobListQuerySchema } from "../packages/modules/notifications/src/validators"
import { GET as GET_JOBS_EMAIL } from "../apps/api/app/api/v1/admin/jobs/email/route"
import { GET as GET_JOB } from "../apps/api/app/api/v1/admin/jobs/email/[jobId]/route"
import { POST as POST_REQUEUE } from "../apps/api/app/api/v1/admin/jobs/email/[jobId]/requeue/route"
import { GET as GET_CRON_RUNS } from "../apps/api/app/api/v1/admin/jobs/cron-runs/route"
import { POST as POST_RUN_CRON } from "../apps/api/app/api/v1/admin/jobs/cron-runs/run/route"

// ─── Seed helpers ─────────────────────────────────────────────────────

function seedJob(overrides: Partial<StoredJob> = {}): StoredJob {
  const id = `job-${store.seq++}`
  const job: StoredJob = {
    id,
    type: "SUBMISSION_NOTIFICATION",
    to: "owner@example.com",
    subject: "New submission",
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: null,
    claimedAt: null,
    lastError: null,
    providerMessageId: null,
    deliveryStatus: null,
    deliveryUpdatedAt: null,
    payload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    formId: "form-1",
    submissionId: null,
    ownerId: "owner-1",
    form: { name: "Contact" },
    owner: { name: "Owner One", email: "owner@example.com" },
    ...overrides,
  }
  store.jobs.set(id, job)
  return job
}

beforeEach(() => {
  store.jobs.clear()
  store.seq = 1
  vi.clearAllMocks()
})

// ─── listEmailJobsForAdmin — filters + pagination + owner search ──────

describe("listEmailJobsForAdmin — filters, pagination, owner search", () => {
  it("lists newest first with counts that sum to all", async () => {
    seedJob({ status: "PENDING", createdAt: new Date("2026-11-26T10:00:00Z") })
    seedJob({ status: "SENT", createdAt: new Date("2026-11-26T11:00:00Z") })
    seedJob({ status: "FAILED", createdAt: new Date("2026-11-26T12:00:00Z") })
    const res = await listEmailJobsForAdmin(ownerActor(), {})
    expect(res.total).toBe(3)
    expect(res.page).toBe(1)
    expect(res.pageSize).toBe(20)
    expect(res.items.map((j) => j.status)).toEqual([
      "FAILED",
      "SENT",
      "PENDING",
    ])
    expect(res.counts).toEqual({
      all: 3,
      pending: 1,
      sending: 0,
      sent: 1,
      failed: 1,
    })
    expect(res.items[0]?.formName).toBe("Contact")
    expect(res.items[0]?.ownerEmail).toBe("owner@example.com")
    expect(res.items[0]?.ownerName).toBe("Owner One")
  })

  it("filters by status tab", async () => {
    seedJob({ status: "PENDING" })
    seedJob({ status: "SENDING", claimedAt: minutesAgo(5) })
    seedJob({ status: "FAILED" })
    const pending = await listEmailJobsForAdmin(ownerActor(), {
      status: "pending",
    })
    expect(pending.items.map((j) => j.status)).toEqual(["PENDING"])
    expect(pending.counts.failed).toBe(1)
    const failed = await listEmailJobsForAdmin(ownerActor(), {
      status: "failed",
    })
    expect(failed.items.map((j) => j.status)).toEqual(["FAILED"])
    // Counts ignore the tab — the tabs always sum to `all`.
    expect(failed.counts).toEqual({
      all: 3,
      pending: 1,
      sending: 1,
      sent: 0,
      failed: 1,
    })
  })

  it("filters by job type", async () => {
    seedJob({ type: "SUBMISSION_NOTIFICATION" })
    seedJob({ type: "DIGEST" })
    const res = await listEmailJobsForAdmin(ownerActor(), {
      type: "DIGEST",
    })
    expect(res.total).toBe(1)
    expect(res.items[0]?.type).toBe("DIGEST")
  })

  it("finds jobs by owner email or name, case-insensitively", async () => {
    seedJob({ owner: { name: "Owner One", email: "owner@example.com" } })
    seedJob({ owner: { name: "Second Owner", email: "two@example.com" } })
    const byEmail = await listEmailJobsForAdmin(ownerActor(), {
      ownerSearch: "TWO@EXAMPLE",
    })
    expect(byEmail.items.map((j) => j.ownerEmail)).toEqual(["two@example.com"])
    const byName = await listEmailJobsForAdmin(ownerActor(), {
      ownerSearch: "second owner",
    })
    expect(byName.items.map((j) => j.ownerEmail)).toEqual(["two@example.com"])
    const none = await listEmailJobsForAdmin(ownerActor(), {
      ownerSearch: "nobody-here",
    })
    expect(none.total).toBe(0)
    expect(none.items).toEqual([])
  })

  it("paginates at 20 per page", async () => {
    for (let i = 0; i < 22; i++) {
      seedJob({
        createdAt: new Date(`2026-11-26T10:${String(i).padStart(2, "0")}:00Z`),
      })
    }
    const page1 = await listEmailJobsForAdmin(ownerActor(), { page: 1 })
    expect(page1.items).toHaveLength(20)
    expect(page1.total).toBe(22)
    const page2 = await listEmailJobsForAdmin(ownerActor(), { page: 2 })
    expect(page2.items).toHaveLength(2)
    expect(page2.page).toBe(2)
    expect(
      page1.items
        .map((j) => j.id)
        .some((id) => page2.items.some((j) => j.id === id))
    ).toBe(false)
  })

  it("exposes claim age and requeueability per row", async () => {
    const stuck = seedJob({ status: "SENDING", claimedAt: minutesAgo(11) })
    const live = seedJob({ status: "SENDING", claimedAt: minutesAgo(5) })
    const failed = seedJob({ status: "FAILED", attempts: 6 })
    const pending = seedJob({ status: "PENDING" })
    const res = await listEmailJobsForAdmin(ownerActor(), {})
    const byId = new Map(res.items.map((j) => [j.id, j]))
    expect(byId.get(stuck.id)?.claimAgeMinutes).toBeGreaterThanOrEqual(11)
    expect(byId.get(stuck.id)?.canRequeue).toBe(true)
    expect(byId.get(live.id)?.claimAgeMinutes).toBeLessThan(10)
    expect(byId.get(live.id)?.canRequeue).toBe(false)
    expect(byId.get(failed.id)?.claimAgeMinutes).toBeNull()
    expect(byId.get(failed.id)?.canRequeue).toBe(true)
    expect(byId.get(pending.id)?.claimAgeMinutes).toBeNull()
    expect(byId.get(pending.id)?.canRequeue).toBe(false)
  })

  it("lets SUPPORT list (VIEW_JOBS) but refuses a plain user", async () => {
    seedJob()
    const res = await listEmailJobsForAdmin(supportActor(), {})
    expect(res.total).toBe(1)
    await expect(
      listEmailJobsForAdmin(plainUserActor(), {})
    ).rejects.toMatchObject({
      status: 403,
    })
  })
})

// ─── getEmailJobForAdmin — single-job read ────────────────────────────

describe("getEmailJobForAdmin — single-job read", () => {
  it("returns the job with owner + form names", async () => {
    const job = seedJob({ status: "FAILED", attempts: 6, lastError: "boom" })
    const res = await getEmailJobForAdmin(ownerActor(), job.id)
    expect(res.id).toBe(job.id)
    expect(res.status).toBe("FAILED")
    expect(res.lastError).toBe("boom")
    expect(res.formName).toBe("Contact")
    expect(res.ownerEmail).toBe("owner@example.com")
    expect(res.canRequeue).toBe(true)
  })

  it("404s for an unknown id", async () => {
    await expect(
      getEmailJobForAdmin(ownerActor(), "no-such-job")
    ).rejects.toMatchObject({ status: 404 })
  })

  it("lets SUPPORT read (VIEW_JOBS) but refuses a plain user", async () => {
    const job = seedJob()
    await expect(
      getEmailJobForAdmin(supportActor(), job.id)
    ).resolves.toMatchObject({
      id: job.id,
    })
    await expect(
      getEmailJobForAdmin(plainUserActor(), job.id)
    ).rejects.toMatchObject({ status: 403 })
  })
})

// ─── requeueEmailJobForAdmin — FAILED / SENDING lease / gates ─────────

describe("requeueEmailJobForAdmin — requeue behaviour", () => {
  it("requeues FAILED → PENDING with attempts reset + audit row", async () => {
    const job = seedJob({
      status: "FAILED",
      attempts: 3,
      lastError: "provider refused",
    })
    const requeued = await requeueEmailJobForAdmin(ownerActor(), job.id)
    expect(requeued.status).toBe("PENDING")
    expect(requeued.attempts).toBe(0)
    expect(requeued.lastError).toBe("provider refused")
    expect(requeued.nextAttemptAt).toBeInstanceOf(Date)
    expect(
      Math.abs(Date.now() - requeued.nextAttemptAt!.getTime())
    ).toBeLessThan(5000)
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        detail: expect.objectContaining({
          event: "email-job-requeued",
          emailJobId: job.id,
          previousStatus: "FAILED",
          previousAttempts: 3,
        }),
      })
    )
  })

  it("refuses SENDING inside the 10-minute lease without touching step-up", async () => {
    const job = seedJob({ status: "SENDING", claimedAt: minutesAgo(5) })
    await expect(
      requeueEmailJobForAdmin(ownerActor(), job.id)
    ).rejects.toMatchObject({ status: 409 })
    expect(store.jobs.get(job.id)?.status).toBe("SENDING")
    expect(mockRequireStepUp).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("allows SENDING past the lease", async () => {
    const job = seedJob({ status: "SENDING", claimedAt: minutesAgo(11) })
    const requeued = await requeueEmailJobForAdmin(ownerActor(), job.id)
    expect(requeued.status).toBe("PENDING")
    expect(requeued.attempts).toBe(0)
  })

  it("refuses PENDING and SENT jobs", async () => {
    const pending = seedJob({ status: "PENDING" })
    const sent = seedJob({ status: "SENT" })
    await expect(
      requeueEmailJobForAdmin(ownerActor(), pending.id)
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      requeueEmailJobForAdmin(ownerActor(), sent.id)
    ).rejects.toMatchObject({ status: 409 })
    expect(mockRequireStepUp).not.toHaveBeenCalled()
  })

  it("404s for an unknown id", async () => {
    await expect(
      requeueEmailJobForAdmin(ownerActor(), "no-such-job")
    ).rejects.toMatchObject({ status: 404 })
    expect(mockRequireStepUp).not.toHaveBeenCalled()
  })

  it("refuses MANAGER and SUPPORT (no MANAGE_JOBS) without touching step-up", async () => {
    const job = seedJob({ status: "FAILED", attempts: 2 })
    await expect(
      requeueEmailJobForAdmin(managerActor(), job.id)
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      requeueEmailJobForAdmin(supportActor(), job.id)
    ).rejects.toMatchObject({ status: 403 })
    expect(store.jobs.get(job.id)?.status).toBe("FAILED")
    expect(mockRequireStepUp).not.toHaveBeenCalled()
  })

  it("refuses when step-up is missing and leaves the job alone", async () => {
    const job = seedJob({ status: "FAILED", attempts: 2 })
    mockRequireStepUp.mockRejectedValueOnce(
      new ApiError("Step-up verification required.", 403)
    )
    await expect(
      requeueEmailJobForAdmin(ownerActor(), job.id)
    ).rejects.toMatchObject({ status: 403 })
    expect(store.jobs.get(job.id)?.status).toBe("FAILED")
    expect(store.jobs.get(job.id)?.attempts).toBe(2)
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("matches the owner requeue on the same job (admin vs owner parity)", async () => {
    const ownerJob = seedJob({
      status: "FAILED",
      attempts: 4,
      lastError: "timeout",
    })
    const adminJob = seedJob({
      status: "FAILED",
      attempts: 4,
      lastError: "timeout",
    })
    const ownerResult = await requeueEmailJob("owner-1", ownerJob.id)
    const adminResult = await requeueEmailJobForAdmin(ownerActor(), adminJob.id)
    expect(ownerResult.status).toBe(adminResult.status)
    expect(ownerResult.attempts).toBe(adminResult.attempts)
    expect(ownerResult.lastError).toBe(adminResult.lastError)
    expect(adminResult.nextAttemptAt).toBeInstanceOf(Date)
    const ownerAudit = mockLogAudit.mock.calls[0]?.[0] as {
      detail: {
        event: string
        previousStatus: string
        previousAttempts: number
        emailJobId: string
      }
    }
    const adminAudit = mockLogAudit.mock.calls[1]?.[0] as {
      userId: string
      detail: {
        event: string
        previousStatus: string
        previousAttempts: number
        emailJobId: string
      }
    }
    // Same audit event, same previous state — only the actor and
    // the job id differ (two different jobs, one requeue each).
    expect(adminAudit.detail.event).toBe(ownerAudit.detail.event)
    expect(adminAudit.detail.previousStatus).toBe(
      ownerAudit.detail.previousStatus
    )
    expect(adminAudit.detail.previousAttempts).toBe(
      ownerAudit.detail.previousAttempts
    )
    expect(adminAudit.detail.emailJobId).toBe(adminJob.id)
    expect(ownerAudit.detail.emailJobId).toBe(ownerJob.id)
    expect(adminAudit.userId).toBe("owner-1")
    // The admin list with an owner search returns the same job the
    // owner list returns for that owner.
    const adminList = await listEmailJobsForAdmin(ownerActor(), {
      ownerSearch: "owner@example.com",
    })
    const ownerList = await listEmailJobsForUser("owner-1", {})
    expect(adminList.items.map((j) => j.id).sort()).toEqual(
      ownerList.items.map((j) => j.id).sort()
    )
  })
})

// ─── Admin validators ─────────────────────────────────────────────────

describe("AdminEmailJobListQuerySchema", () => {
  it("defaults the tab to all and the page to 1", () => {
    expect(AdminEmailJobListQuerySchema.parse({})).toEqual({
      status: "all",
      page: 1,
    })
    expect(
      AdminEmailJobListQuerySchema.parse({ status: "failed", page: "2" })
    ).toEqual({ status: "failed", page: 2 })
  })

  it("rejects an unknown tab, an unknown type, and a blank owner search", () => {
    expect(
      AdminEmailJobListQuerySchema.safeParse({ status: "sent" }).success
    ).toBe(false)
    expect(
      AdminEmailJobListQuerySchema.safeParse({ type: "NOPE" }).success
    ).toBe(false)
    expect(
      AdminEmailJobListQuerySchema.safeParse({ ownerSearch: "  " }).success
    ).toBe(false)
  })
})

// ─── Routes: jobs/email ───────────────────────────────────────────────

describe("GET /api/v1/admin/jobs/email", () => {
  const url = "http://localhost:3001/api/v1/admin/jobs/email?status=failed"

  it("returns the list and gates on VIEW_JOBS", async () => {
    const res = await GET_JOBS_EMAIL(new NextRequest(url))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      counts: { all: 0, pending: 0, sending: 0, sent: 0, failed: 0 },
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_JOBS")
    expect(mockListEmailJobsForAdmin).toHaveBeenCalledWith(mockSession, {
      status: "failed",
      page: 1,
    })
  })

  it("returns 422 for an unknown tab without calling the service", async () => {
    const res = await GET_JOBS_EMAIL(
      new NextRequest(
        "http://localhost:3001/api/v1/admin/jobs/email?status=bogus"
      )
    )
    expect(res.status).toBe(422)
    expect(mockListEmailJobsForAdmin).not.toHaveBeenCalled()
  })

  it("returns 422 for an unknown type without calling the service", async () => {
    const res = await GET_JOBS_EMAIL(
      new NextRequest("http://localhost:3001/api/v1/admin/jobs/email?type=NOPE")
    )
    expect(res.status).toBe(422)
    expect(mockListEmailJobsForAdmin).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks VIEW_JOBS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_JOBS_EMAIL(new NextRequest(url))
    expect(res.status).toBe(403)
    expect(mockListEmailJobsForAdmin).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the list", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET_JOBS_EMAIL(new NextRequest(url))
    expect(res.status).toBe(429)
    expect(mockListEmailJobsForAdmin).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/admin/jobs/email/[jobId]", () => {
  const url = "http://localhost:3001/api/v1/admin/jobs/email/job-1"

  it("returns the detail and gates on VIEW_JOBS", async () => {
    const res = await GET_JOB(new NextRequest(url), {
      params: Promise.resolve({ jobId: "job-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "job-1" })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_JOBS")
    expect(mockGetEmailJobForAdmin).toHaveBeenCalledWith(mockSession, "job-1")
  })

  it("returns 403 when the actor lacks VIEW_JOBS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_JOB(new NextRequest(url), {
      params: Promise.resolve({ jobId: "job-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockGetEmailJobForAdmin).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/admin/jobs/email/[jobId]/requeue", () => {
  const url = "http://localhost:3001/api/v1/admin/jobs/email/job-1/requeue"

  it("requeues and gates on MANAGE_JOBS", async () => {
    const res = await POST_REQUEUE(new NextRequest(url, { method: "POST" }), {
      params: Promise.resolve({ jobId: "job-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "job-1", status: "PENDING" })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_JOBS")
    expect(mockRequeueEmailJobForAdmin).toHaveBeenCalledWith(
      mockSession,
      "job-1"
    )
  })

  it("returns 403 when the actor lacks MANAGE_JOBS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await POST_REQUEUE(new NextRequest(url, { method: "POST" }), {
      params: Promise.resolve({ jobId: "job-1" }),
    })
    expect(res.status).toBe(403)
    expect(mockRequeueEmailJobForAdmin).not.toHaveBeenCalled()
  })
})

// ─── Routes: jobs/cron-runs (Stream A service, mocked here) ───────────

describe("GET /api/v1/admin/jobs/cron-runs", () => {
  const url = "http://localhost:3001/api/v1/admin/jobs/cron-runs"

  it("returns the list and gates on VIEW_JOBS", async () => {
    const res = await GET_CRON_RUNS(new NextRequest(url))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      runs: [],
      total: 0,
      page: 1,
      perPage: 20,
      totalPages: 1,
    })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("VIEW_JOBS")
    expect(mockListCronRuns).toHaveBeenCalledWith(mockSession, {
      page: 1,
      perPage: 20,
    })
  })

  it("passes filters through to listCronRuns", async () => {
    const res = await GET_CRON_RUNS(
      new NextRequest(
        `${url}?status=FAILED&trigger=MANUAL&page=2&perPage=5&jobName=EMAIL_OUTBOX`
      )
    )
    expect(res.status).toBe(200)
    expect(mockListCronRuns).toHaveBeenCalledWith(mockSession, {
      page: 2,
      perPage: 5,
      jobName: "EMAIL_OUTBOX",
      status: "FAILED",
      trigger: "MANUAL",
    })
  })

  it("returns 422 for an unknown status without calling the service", async () => {
    const res = await GET_CRON_RUNS(new NextRequest(`${url}?status=BROKEN`))
    expect(res.status).toBe(422)
    expect(mockListCronRuns).not.toHaveBeenCalled()
  })

  it("returns 422 for a bad page without calling the service", async () => {
    const res = await GET_CRON_RUNS(new NextRequest(`${url}?page=0`))
    expect(res.status).toBe(422)
    expect(mockListCronRuns).not.toHaveBeenCalled()
  })

  it("returns 403 when the actor lacks VIEW_JOBS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await GET_CRON_RUNS(new NextRequest(url))
    expect(res.status).toBe(403)
    expect(mockListCronRuns).not.toHaveBeenCalled()
  })

  it("returns the rate-limit response instead of the list", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new NextResponse(null, { status: 429 })
    )
    const res = await GET_CRON_RUNS(new NextRequest(url))
    expect(res.status).toBe(429)
    expect(mockListCronRuns).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/admin/jobs/cron-runs/run", () => {
  const url = "http://localhost:3001/api/v1/admin/jobs/cron-runs/run"

  it("runs the cron and gates on MANAGE_JOBS (step-up lives in the service)", async () => {
    const res = await POST_RUN_CRON(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "SUCCESS", processed: 0 })
    expect(mockRequireAdminApi).toHaveBeenCalledWith("MANAGE_JOBS")
    expect(mockRunManualEmailOutboxCron).toHaveBeenCalledWith(mockSession)
  })

  it("returns 403 when the actor lacks MANAGE_JOBS", async () => {
    mockRequireAdminApi.mockRejectedValueOnce(new ApiError("Forbidden", 403))
    const res = await POST_RUN_CRON(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(403)
    expect(mockRunManualEmailOutboxCron).not.toHaveBeenCalled()
  })

  it("returns 403 when the service refuses (step-up is enforced in the service)", async () => {
    mockRunManualEmailOutboxCron.mockRejectedValueOnce(
      new ApiError("Step-up verification required.", 403)
    )
    const res = await POST_RUN_CRON(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(403)
  })
})

// ─── Capability gate (Q9, plan §3.6) ───────────────────────────────────

describe("Jobs — capability gate (Q9, plan §3.6)", () => {
  it("is gated on VIEW_JOBS in PLATFORM_ROUTE_CAPABILITY", () => {
    expect(PLATFORM_ROUTE_CAPABILITY["/admin/jobs"]).toBe("VIEW_JOBS")
  })

  it("grants VIEW_JOBS to all staff (Health-page parity)", () => {
    for (const role of [
      "PLATFORM_OWNER",
      "SUPER_ADMIN",
      "MANAGER",
      "SUPPORT",
    ] as const) {
      expect(adminCan(role, "VIEW_JOBS"), role).toBe(true)
    }
    expect(adminCan("PLATFORM_USER", "VIEW_JOBS")).toBe(false)
  })

  it("grants MANAGE_JOBS to SUPER_ADMIN + owner only", () => {
    expect(adminCan("PLATFORM_OWNER", "MANAGE_JOBS")).toBe(true)
    expect(adminCan("SUPER_ADMIN", "MANAGE_JOBS")).toBe(true)
    expect(adminCan("MANAGER", "MANAGE_JOBS")).toBe(false)
    expect(adminCan("SUPPORT", "MANAGE_JOBS")).toBe(false)
    expect(adminCan("PLATFORM_USER", "MANAGE_JOBS")).toBe(false)
  })
})

// ─── Routes stay thin ─────────────────────────────────────────────────

describe("Jobs — routes stay thin", () => {
  it("the three email routes gate, validate, and delegate — nothing else", () => {
    const list = read("apps/api/app/api/v1/admin/jobs/email/route.ts")
    expect(list).toContain('requireAdminApi("VIEW_JOBS")')
    expect(list).toContain("AdminEmailJobListQuerySchema")
    expect(list).toContain("listEmailJobsForAdmin")
    expect(list).toContain("handleApiError")
    expect(list).not.toContain("@sendcms/database")
    expect(list).not.toContain("revalidatePath")
    const detail = read("apps/api/app/api/v1/admin/jobs/email/[jobId]/route.ts")
    expect(detail).toContain('requireAdminApi("VIEW_JOBS")')
    expect(detail).toContain("getEmailJobForAdmin")
    expect(detail).not.toContain("@sendcms/database")
    expect(detail).not.toContain("revalidatePath")
    const requeue = read(
      "apps/api/app/api/v1/admin/jobs/email/[jobId]/requeue/route.ts"
    )
    expect(requeue).toContain('requireAdminApi("MANAGE_JOBS")')
    expect(requeue).toContain("requeueEmailJobForAdmin")
    // Step-up lives in the service, never in the route — the
    // Payments refund pattern (Phase B).
    expect(requeue).not.toContain("requireStepUp")
    expect(requeue).not.toContain("@sendcms/database")
    expect(requeue).not.toContain("revalidatePath")
  })

  it("the two cron routes gate, validate, and delegate to Stream A's service — nothing else", () => {
    const list = read("apps/api/app/api/v1/admin/jobs/cron-runs/route.ts")
    expect(list).toContain('requireAdminApi("VIEW_JOBS")')
    expect(list).toContain("CronRunsQuerySchema")
    expect(list).toContain("listCronRuns")
    expect(list).toContain("handleApiError")
    expect(list).not.toContain("@sendcms/database")
    expect(list).not.toContain("revalidatePath")
    // No cron logic lives in the route: it never calls the cron
    // runner or the outbox drain directly.
    expect(list).not.toContain("runEmailOutboxCron")
    expect(list).not.toContain("processEmailOutbox")
    const run = read("apps/api/app/api/v1/admin/jobs/cron-runs/run/route.ts")
    expect(run).toContain('requireAdminApi("MANAGE_JOBS")')
    expect(run).toContain("runManualEmailOutboxCron")
    expect(run).not.toContain("@sendcms/database")
    expect(run).not.toContain("revalidatePath")
    expect(run).not.toContain("runEmailOutboxCron(")
    expect(run).not.toContain("processEmailOutbox")
    // Step-up lives in the service, never in the route — the
    // Payments refund pattern (Phase B). The service checks it
    // last, after the MANAGE_JOBS guard, immediately before the run.
    expect(run).not.toContain("requireStepUp")
  })
})
