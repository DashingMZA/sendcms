// Wave 9 Stream A — email outbox: claim lease + backoff + terminal
// boundary + counts + requeue + SENDING filter + worker-condition
// render (EML-001/030/061/090, EML-031/006/SRC-302, EML-032/060,
// EML-033, EML-034, EML-038, EML-039, DSH-203, TST-015).
// Mocked Prisma client; no live DB needed — except the tsx render
// test, which spawns the real worker-runtime probe (TST-015).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  submission: { findUnique: vi.fn() },
  submissionEvent: { create: vi.fn() },
  notificationSettings: { findMany: vi.fn() },
  form: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  // Wave 9, Stream C (EML-005): the enqueue/send paths check the
  // suppression list — the mock returns "not suppressed" by default.
  emailSuppression: { findFirst: vi.fn(), create: vi.fn() },
  emailJob: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    create: vi.fn(),
  },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})
const mockLogAudit = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@sendcms/security", () => ({ logAudit: mockLogAudit }))
const mockSendEmail = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1", provider: "resend" }))
)
const mockRenderNotification = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>hi</p>", text: "hi" }))
)
const mockRenderDigest = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>digest</p>", text: "digest" }))
)
const mockRenderReply = vi.hoisted(() =>
  vi.fn(async () => ({ html: "<p>reply</p>", text: "reply" }))
)
vi.mock("@sendcms/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/email")>()
  return {
    ...actual,
    notificationDeps: {
      sendEmail: mockSendEmail,
      renderNotification: mockRenderNotification,
      renderDigest: mockRenderDigest,
      renderReply: mockRenderReply,
    },
  }
})
vi.mock("@sendcms/users", () => ({
  getUserLocale: vi.fn(async () => null),
}))

import {
  MAX_EMAIL_ATTEMPTS,
  STALE_CLAIM_LEASE_MINUTES,
  claimDueEmailJobs,
  claimEmailJob,
  markEmailJobFailed,
  markEmailJobSent,
  nextAttemptDelayMs,
  readEmailJobAttempts,
  staleClaimCutoff,
} from "@sendcms/queue"
import {
  TerminalJobError,
  listEmailJobsForUser,
  processEmailOutbox,
  requeueEmailJob,
} from "@sendcms/notifications"

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    formId: "form-1",
    status: "NEW",
    data: { name: "Sara", email: "sara@example.com", message: "Hello" },
    pageUrl: "https://example.com/contact",
    originDomain: "example.com",
    createdAt: new Date(),
    form: { id: "form-1", name: "Contact us", ownerId: "user-1" },
    ...overrides,
  }
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    type: "SUBMISSION_NOTIFICATION",
    to: "owner@example.com",
    subject: "New submission",
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    providerMessageId: null,
    claimedAt: null,
    formId: "form-1",
    ownerId: "user-1",
    submissionId: "sub-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeLoadedJob(overrides: Record<string, unknown> = {}) {
  return {
    ...makeJob(overrides),
    form: { id: "form-1", name: "Contact us" },
    submission: makeSubmission(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.submission.findUnique.mockResolvedValue(makeSubmission())
  mockDb.notificationSettings.findMany.mockResolvedValue([
    { email: "owner@example.com" },
  ])
  mockDb.emailJob.createMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.findMany.mockResolvedValue([])
  mockDb.emailJob.findUnique.mockResolvedValue(makeLoadedJob())
  mockDb.emailJob.updateMany.mockResolvedValue({ count: 1 })
  mockDb.emailJob.update.mockResolvedValue({})
  mockDb.emailJob.count.mockResolvedValue(0)
  mockDb.emailJob.groupBy.mockResolvedValue([])
  mockDb.submissionEvent.create.mockResolvedValue({})
  mockDb.emailSuppression.findFirst.mockResolvedValue(null)
  mockDb.emailSuppression.create.mockResolvedValue({})
  mockSendEmail.mockResolvedValue({
    messageId: "msg-1",
    provider: "resend",
  })
})

describe("EML-033 — retry ladder: five retries, terminal after attempt 6", () => {
  it("schedules 1m/5m/15m/1h/4h for attempts 1–5 and clamps at 4h", () => {
    expect([
      nextAttemptDelayMs(1),
      nextAttemptDelayMs(2),
      nextAttemptDelayMs(3),
      nextAttemptDelayMs(4),
      nextAttemptDelayMs(5),
    ]).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000])
    expect(nextAttemptDelayMs(6)).toBe(4 * 60 * 60_000)
    expect(MAX_EMAIL_ATTEMPTS).toBe(6)
  })

  it("keeps attempt 5 retryable with the 4h delay and fails attempt 6 terminally", async () => {
    const delays = [
      60_000,
      5 * 60_000,
      15 * 60_000,
      60 * 60_000,
      4 * 60 * 60_000,
    ]
    for (let attempts = 1; attempts <= 5; attempts++) {
      mockDb.emailJob.findUnique.mockResolvedValue({ attempts })
      mockDb.emailJob.update.mockClear()
      const before = Date.now()
      await markEmailJobFailed("job-1", { error: "provider down" })
      const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
        data: { status: string; nextAttemptAt: Date | null }
      }
      expect(updateArg.data.status).toBe("PENDING")
      const delay = (updateArg.data.nextAttemptAt as Date).getTime() - before
      expect(delay).toBeGreaterThanOrEqual(delays[attempts - 1] - 1000)
      expect(delay).toBeLessThan(delays[attempts - 1] + 5000)
    }
    mockDb.emailJob.findUnique.mockResolvedValue({ attempts: 6 })
    mockDb.emailJob.update.mockClear()
    await markEmailJobFailed("job-1", { error: "provider down" })
    const terminalArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(terminalArg.data.status).toBe("FAILED")
    expect(terminalArg.data.nextAttemptAt).toBeNull()
  })
})

describe("EML-031/EML-006 — stale-claim lease", () => {
  it("sets claimedAt on claim and clears it on sent/failed", async () => {
    await claimEmailJob("job-1")
    const claimArg = mockDb.emailJob.updateMany.mock.calls[0][0] as {
      data: { claimedAt: Date }
    }
    expect(claimArg.data.claimedAt).toBeInstanceOf(Date)

    await markEmailJobSent("job-1", "msg-1")
    const sentArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { claimedAt: null }
    }
    expect(sentArg.data.claimedAt).toBeNull()

    mockDb.emailJob.findUnique.mockResolvedValue({ attempts: 1 })
    await markEmailJobFailed("job-1", { error: "provider down" })
    const failedArg = mockDb.emailJob.update.mock.calls[1][0] as {
      data: { claimedAt: null }
    }
    expect(failedArg.data.claimedAt).toBeNull()
  })

  it("claimDueEmailJobs also returns SENDING rows past the 10-minute lease", async () => {
    await claimDueEmailJobs(25)
    const where = mockDb.emailJob.findMany.mock.calls[0][0].where as {
      OR: Array<Record<string, unknown>>
    }
    const sendingArm = where.OR.find(
      (arm) => (arm as { status?: string }).status === "SENDING"
    ) as { OR: Array<{ claimedAt?: { lte: Date } | null }> }
    expect(sendingArm).toBeDefined()
    const cutoff = (
      sendingArm.OR.find((c) => c.claimedAt && "lte" in c.claimedAt)
        ?.claimedAt as { lte: Date }
    ).lte
    const ageMs = Date.now() - cutoff.getTime()
    expect(ageMs).toBeGreaterThanOrEqual(
      STALE_CLAIM_LEASE_MINUTES * 60_000 - 5000
    )
    expect(ageMs).toBeLessThan(STALE_CLAIM_LEASE_MINUTES * 60_000 + 5000)
    // The PENDING arm is still there (due jobs, oldest first).
    expect(
      where.OR.some((arm) => (arm as { status?: string }).status === "PENDING")
    ).toBe(true)
  })

  it("staleClaimCutoff is 10 minutes before now", () => {
    const now = new Date("2026-11-25T12:00:00Z")
    expect(staleClaimCutoff(now).toISOString()).toBe("2026-11-25T11:50:00.000Z")
  })

  it("re-claims a stale SENDING job: the next drain retries it", async () => {
    const stale = makeJob({
      status: "SENDING",
      attempts: 1,
      claimedAt: new Date(Date.now() - 11 * 60_000),
    })
    mockDb.emailJob.findMany.mockResolvedValue([stale])
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 0 })
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })
})

describe("EML-032/EML-060 — due-aware atomic claim + post-claim attempts", () => {
  it("claimEmailJob re-validates due-ness and the lease in the same updateMany", async () => {
    await claimEmailJob("job-1")
    const arg = mockDb.emailJob.updateMany.mock.calls[0][0] as {
      where: { id: string; OR: Array<Record<string, unknown>> }
      data: { status: string; attempts: { increment: number } }
    }
    expect(arg.where.id).toBe("job-1")
    expect(
      arg.where.OR.some(
        (arm) => (arm as { status?: string }).status === "PENDING"
      )
    ).toBe(true)
    expect(
      arg.where.OR.some(
        (arm) => (arm as { status?: string }).status === "SENDING"
      )
    ).toBe(true)
    expect(arg.data.status).toBe("SENDING")
    expect(arg.data.attempts).toEqual({ increment: 1 })
  })

  it("readEmailJobAttempts reads the row, never the snapshot", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue({ attempts: 4 })
    await expect(readEmailJobAttempts("job-1")).resolves.toBe(4)
    expect(mockDb.emailJob.findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
      select: { attempts: true },
    })
  })

  it("computes the retry delay from the post-claim attempts, not the snapshot", async () => {
    // Snapshot says attempts 0, but the row the claim wrote says 5
    // (e.g. a re-claimed stale SENDING row): the failure must
    // schedule the 4h rung, not the 1m rung.
    mockDb.emailJob.findMany.mockResolvedValue([makeJob({ attempts: 0 })])
    mockDb.emailJob.findUnique.mockResolvedValue(makeLoadedJob({ attempts: 5 }))
    mockSendEmail.mockRejectedValue(new Error("provider down"))
    const before = Date.now()
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(updateArg.data.status).toBe("PENDING")
    const delay = (updateArg.data.nextAttemptAt as Date).getTime() - before
    expect(delay).toBeGreaterThanOrEqual(4 * 60 * 60_000 - 1000)
    expect(delay).toBeLessThan(4 * 60 * 60_000 + 5000)
  })

  it("goes terminal when the post-claim attempts hit the limit even if the snapshot did not", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob({ attempts: 5 })])
    mockDb.emailJob.findUnique.mockResolvedValue(makeLoadedJob({ attempts: 6 }))
    mockSendEmail.mockRejectedValue(new Error("provider down"))
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; nextAttemptAt: Date | null }
    }
    expect(updateArg.data.status).toBe("FAILED")
    expect(updateArg.data.nextAttemptAt).toBeNull()
  })
})

describe("EML-038 — processed counts attempted jobs, skipped is separate", () => {
  it("reports processed == sent + failed and skipped separately", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([
      makeJob({ id: "job-1" }),
      makeJob({ id: "job-2" }),
    ])
    // First claim wins, second loses to the other processor.
    mockDb.emailJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 })
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 1 })
    expect(result.processed).toBe(result.sent + result.failed)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })
})

describe("EML-039 — terminal classification is the error type, not the wording", () => {
  it("goes terminal on first attempt for a renamed terminal error", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    mockSendEmail.mockRejectedValue(
      new TerminalJobError("Something completely different happened.")
    )
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 })
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("FAILED")
  })

  it("does not go terminal for a plain error with a terminal-sounding message", async () => {
    mockDb.emailJob.findMany.mockResolvedValue([makeJob()])
    mockSendEmail.mockRejectedValue(
      new Error("Submission or form no longer exists.")
    )
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, skipped: 0 })
    // A plain Error carrying the old wording is retriable now — the
    // terminal path requires the typed error. Only the wording
    // changed hands, so the job stays PENDING.
    const updateArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string }
    }
    expect(updateArg.data.status).toBe("PENDING")
  })
})

describe("EML-034 — FAILED requeues and the next drain attempts it", () => {
  it("requeues a FAILED job (attempts reset, audit-logged) and the drain sends it", async () => {
    mockDb.emailJob.findUnique.mockResolvedValue(
      makeJob({ status: "FAILED", attempts: 6 })
    )
    const requeued = await requeueEmailJob("user-1", "job-1")
    expect(requeued).toBeDefined()
    const requeueArg = mockDb.emailJob.update.mock.calls[0][0] as {
      data: { status: string; attempts: number; nextAttemptAt: Date }
    }
    expect(requeueArg.data.status).toBe("PENDING")
    expect(requeueArg.data.attempts).toBe(0)
    expect(requeueArg.data.nextAttemptAt).toBeInstanceOf(Date)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ event: "email-job-requeued" }),
      })
    )

    mockDb.emailJob.findMany.mockResolvedValue([makeJob({ attempts: 0 })])
    mockDb.emailJob.findUnique.mockResolvedValue(makeLoadedJob({ attempts: 1 }))
    const result = await processEmailOutbox()
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 0 })
  })
})

describe("DSH-203 — SENDING is filterable and counts reconcile", () => {
  it("returns a SENDING job under ?status=SENDING and counts.all == pending + sent + failed + sending", async () => {
    const sending = makeJob({
      status: "SENDING",
      claimedAt: new Date(Date.now() - 30 * 60_000),
      updatedAt: new Date(Date.now() - 30 * 60_000),
    })
    mockDb.emailJob.findMany.mockResolvedValue([
      { ...sending, form: { name: "Contact us" } },
    ])
    mockDb.emailJob.count.mockResolvedValue(1)
    mockDb.emailJob.groupBy.mockResolvedValue([
      { status: "PENDING", _count: 2 },
      { status: "SENDING", _count: 1 },
      { status: "SENT", _count: 3 },
      { status: "FAILED", _count: 1 },
    ])
    const result = await listEmailJobsForUser("user-1", { status: "SENDING" })
    expect(mockDb.emailJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SENDING" }),
      })
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0].claimAgeMinutes).toBe(30)
    expect(result.items[0].canRequeue).toBe(true)
    expect(result.counts).toEqual({
      all: 7,
      pending: 2,
      sending: 1,
      sent: 3,
      failed: 1,
    })
    expect(result.counts.all).toBe(
      result.counts.pending +
        result.counts.sent +
        result.counts.failed +
        result.counts.sending
    )
  })
})

describe("TST-015 — templates render under the worker (tsx) runtime", () => {
  const templates = [
    "digest.tsx",
    "layout.tsx",
    "reply.tsx",
    "reset-password.tsx",
    "submission-notification.tsx",
    "verify-email.tsx",
  ]

  it("every template imports React (the import tsx needs)", () => {
    for (const name of templates) {
      const src = readFileSync(
        path.join(process.cwd(), "packages/email/src/templates", name),
        "utf8"
      )
      expect(src).toContain('import React from "react"')
    }
  })

  it("renders every real template under tsx from the worker directory", () => {
    const tsx = path.join(process.cwd(), "node_modules/.bin/tsx")
    const probe = path.join(process.cwd(), "tests/tsx-render-probe.ts")
    const run = spawnSync(tsx, [probe], {
      cwd: path.join(process.cwd(), "services/email-worker"),
      encoding: "utf8",
      timeout: 120_000,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("all templates rendered")
  }, 120_000)
})
