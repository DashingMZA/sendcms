// Daily email-outbox cron route (TST-004): auth, per-step isolation,
// the response shape, double-call idempotency, and the last-run
// surface — with the step services mocked, so these tests pin the
// route + orchestration's own decisions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { processEmailOutbox } from "@sendcms/notifications"
import type {
  rescoreNewSubmissions,
  sendDueDigests,
} from "@sendcms/submissions"
import type { expireSubscriptions } from "@sendcms/plans"

const mockProcessOutbox = vi.hoisted(() =>
  vi.fn<typeof processEmailOutbox>(async () => ({
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  }))
)
const mockRescore = vi.hoisted(() =>
  vi.fn<typeof rescoreNewSubmissions>(async () => ({
    checked: 0,
    markedSpam: 0,
    skipped: 0,
  }))
)
const mockDigest = vi.hoisted(() =>
  vi.fn<typeof sendDueDigests>(async () => ({ sent: 0, skipped: 0 }))
)
const mockExpire = vi.hoisted(() =>
  vi.fn<typeof expireSubscriptions>(async () => [])
)
const mockFindMany = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockEnqueue = vi.hoisted(() => vi.fn(async () => 1))
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
// The reconciliation step runs for real against a fake database
// (its own unit tests live in tests/cron-reconcile.test.ts); only
// the Prisma client is swapped, all other database exports stay real.
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return {
    ...actual,
    db: {
      submission: { findMany: mockFindMany },
      emailJob: { count: mockCount },
    },
  }
})

import { NextRequest } from "next/server"
import { GET, maxDuration } from "../apps/api/app/api/cron/email-outbox/route"
import { getLastCronRun } from "@sendcms/cron"

const URL = "http://localhost:3000/api/cron/email-outbox"
const SECRET = "test-cron-secret"

function cronRequest(auth?: string) {
  return new NextRequest(URL, {
    method: "GET",
    headers: auth === undefined ? {} : { authorization: auth },
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
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
  mockFindMany.mockResolvedValue([{ id: "sub-old", formId: "form-1" }])
  mockCount.mockResolvedValue(0)
  mockEnqueue.mockResolvedValue(1)
})

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.clearAllMocks()
})

describe("GET /api/cron/email-outbox", () => {
  it("exports maxDuration 60, the Hobby max (EML-062)", () => {
    expect(maxDuration).toBe(60)
  })

  it("returns 401 without the cron secret", async () => {
    const res = await GET(cronRequest())
    expect(res.status).toBe(401)
    expect(mockProcessOutbox).not.toHaveBeenCalled()
  })

  it("returns 401 with the wrong cron secret", async () => {
    const res = await GET(cronRequest("Bearer wrong-secret"))
    expect(res.status).toBe(401)
    expect(mockProcessOutbox).not.toHaveBeenCalled()
  })

  it("returns 503 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(res.status).toBe(503)
    expect(mockProcessOutbox).not.toHaveBeenCalled()
  })

  it("runs every step and reports the full shape (EML-068, SRC-201)", async () => {
    const res = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(mockProcessOutbox).toHaveBeenCalledWith({ limit: 25 })
    expect(mockRescore).toHaveBeenCalledWith({ limit: 25 })
    expect(mockDigest).toHaveBeenCalledWith({ limit: 25 })
    expect(mockExpire).toHaveBeenCalledTimes(1)
    expect(mockExpire.mock.calls[0][0]).toBeInstanceOf(Date)
    expect(mockFindMany).toHaveBeenCalled()
    expect(mockEnqueue).toHaveBeenCalledWith("form-1", "sub-old")
    expect(body).toMatchObject({
      processed: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
      outboxError: null,
      rescored: 3,
      markedSpam: 1,
      rescoreSkipped: 5,
      rescoreError: null,
      digests: 2,
      digestSkipped: 7,
      digestError: null,
      subscriptionsExpired: 1,
      subscriptionsCanceled: 1,
      expiryError: null,
      reconciled: 1,
      reconcileJobsCreated: 1,
      reconcileError: null,
    })
    expect(typeof body.durationMs).toBe("number")
    expect(Number.isNaN(Date.parse(body.runAt as string))).toBe(false)
  })

  it("is idempotent: a double call re-processes no jobs", async () => {
    let remaining = 2
    mockProcessOutbox.mockImplementation(async () => {
      const processed = remaining
      remaining = 0
      return { processed, sent: processed, failed: 0, skipped: 0 }
    })
    const first = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(first.status).toBe(200)
    expect(((await first.json()) as { processed: number }).processed).toBe(2)
    const second = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(second.status).toBe(200)
    expect(((await second.json()) as { processed: number }).processed).toBe(0)
    expect(mockProcessOutbox).toHaveBeenCalledTimes(2)
  })

  it("keeps 200 with partial results when the outbox throws (EML-063)", async () => {
    mockProcessOutbox.mockRejectedValueOnce(new Error("db down"))
    const res = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.outboxError).toBe("db down")
    expect(body.processed).toBe(0)
    // The other steps still ran.
    expect(mockRescore).toHaveBeenCalledTimes(1)
    expect(mockDigest).toHaveBeenCalledTimes(1)
    expect(mockExpire).toHaveBeenCalledTimes(1)
    expect(body.reconciled).toBe(1)
    expect(body.rescored).toBe(3)
    expect(body.digests).toBe(2)
  })

  it("keeps 200 with partial results when rescore throws (EML-063)", async () => {
    mockRescore.mockRejectedValueOnce(new Error("model down"))
    const res = await GET(cronRequest(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.rescoreError).toBe("model down")
    expect(body.rescored).toBe(0)
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    expect(mockDigest).toHaveBeenCalledTimes(1)
    expect(mockExpire).toHaveBeenCalledTimes(1)
    expect(body.reconciled).toBe(1)
    expect(body.processed).toBe(2)
  })

  it("records the last run and logs one line per run (EML-064)", async () => {
    const lines: string[] = []
    const origStdout = process.stdout.write.bind(process.stdout)
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const res = await GET(cronRequest(`Bearer ${SECRET}`))
      expect(res.status).toBe(200)
    } finally {
      process.stdout.write = origStdout
      process.stderr.write = origStderr
    }
    const lastRun = getLastCronRun()
    expect(lastRun).not.toBeNull()
    expect(lastRun?.processed).toBe(2)
    expect(lastRun?.sent).toBe(1)
    expect(lastRun?.rescoreSkipped).toBe(5)
    expect(lastRun?.digestSkipped).toBe(7)
    expect(typeof lastRun?.durationMs).toBe("number")
    const logged = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && entry.scope === "cron:email-outbox"
      )
    expect(logged.length).toBeGreaterThanOrEqual(1)
    expect(logged[0]).toMatchObject({ processed: 2, sent: 1 })
  })
})
