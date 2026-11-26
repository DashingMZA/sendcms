// Standalone email worker (Phase 9): the poll loop, the health
// endpoint, and graceful shutdown — with the outbox processor mocked,
// so these tests pin the worker's own behavior.
import { afterEach, describe, expect, it, vi } from "vitest"
import type { processEmailOutbox } from "@sendcms/notifications"
import type {
  rescoreNewSubmissions,
  sendDueDigests,
} from "@sendcms/submissions"
import type { expireSubscriptions } from "@sendcms/plans"
import type {
  getEmailQueueDepth,
  getRecentFailedEmailJobs,
} from "@sendcms/platform-ops"

const mockProcessOutbox = vi.hoisted(() =>
  vi.fn<typeof processEmailOutbox>(async () => ({
    processed: 1,
    sent: 1,
    failed: 0,
    skipped: 0,
  }))
)
const mockRescore = vi.hoisted(() =>
  vi.fn<typeof rescoreNewSubmissions>(async () => ({
    checked: 2,
    markedSpam: 1,
    skipped: 0,
  }))
)
const mockDigest = vi.hoisted(() =>
  vi.fn<typeof sendDueDigests>(async () => ({ sent: 1, skipped: 0 }))
)
const mockExpire = vi.hoisted(() =>
  vi.fn<typeof expireSubscriptions>(async () => [])
)
const mockQueueDepth = vi.hoisted(() =>
  vi.fn<typeof getEmailQueueDepth>(async () => ({
    pending: 0,
    pendingDue: 0,
    sending: 0,
    failed: 0,
    stuckSendingAgeMinutes: null,
  }))
)
const mockRecentFailed = vi.hoisted(() =>
  vi.fn<typeof getRecentFailedEmailJobs>(async () => [])
)
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
}))
vi.mock("@sendcms/submissions", () => ({
  rescoreNewSubmissions: mockRescore,
  sendDueDigests: mockDigest,
}))
vi.mock("@sendcms/plans", () => ({
  expireSubscriptions: mockExpire,
}))
vi.mock("@sendcms/platform-ops", () => ({
  getEmailQueueDepth: mockQueueDepth,
  getRecentFailedEmailJobs: mockRecentFailed,
}))
vi.mock("@sendcms/queue", () => ({
  STALE_CLAIM_LEASE_MINUTES: 10,
}))
import { createEmailWorker } from "@sendcms/email-worker/worker"

let worker: ReturnType<typeof createEmailWorker> | null = null

const SINGLE_RUN = {
  processed: 1,
  sent: 1,
  failed: 0,
  skipped: 0,
  rescored: 2,
  markedSpam: 1,
  rescoreSkipped: 0,
  digests: 1,
  digestSkipped: 0,
  expired: 0,
  canceled: 0,
}

afterEach(async () => {
  if (worker) {
    await worker.stop()
    worker = null
  }
  vi.clearAllMocks()
  mockProcessOutbox.mockResolvedValue({
    processed: 1,
    sent: 1,
    failed: 0,
    skipped: 0,
  })
  mockRescore.mockResolvedValue({ checked: 2, markedSpam: 1, skipped: 0 })
  mockDigest.mockResolvedValue({ sent: 1, skipped: 0 })
  mockExpire.mockResolvedValue([])
  mockQueueDepth.mockResolvedValue({
    pending: 0,
    pendingDue: 0,
    sending: 0,
    failed: 0,
    stuckSendingAgeMinutes: null,
  })
  mockRecentFailed.mockResolvedValue([])
})

/** Captures everything the structured loggers write (info/warn go to
    stdout, error to stderr) until `restore()` is called. */
function captureOutput() {
  const chunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    chunks,
    restore: () => {
      process.stdout.write = origOut
      process.stderr.write = origErr
    },
  }
}

describe("createEmailWorker", () => {
  it("polls the outbox on start and serves a health endpoint", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 50 })
    await worker.start()
    // The immediate poll on start + the interval polls.
    await vi.waitFor(() => {
      expect(mockProcessOutbox).toHaveBeenCalled()
    })
    const res = await fetch(`http://localhost:${worker.getPort()}/health`)
    expect(res.status).toBe(200)
    const health = (await res.json()) as {
      status: string
      polling: boolean
      lastRun: Record<string, number> | null
      totals: Record<string, number>
      lastError: string | null
      lastJobError: string | null
      queue: Record<string, number | null> | null
    }
    expect(health.status).toBe("ok")
    expect(health.polling).toBe(true)
    expect(health.lastRun).toEqual(SINGLE_RUN)
    expect(health.lastError).toBeNull()
    expect(health.lastJobError).toBeNull()
    expect(health.totals.processed).toBeGreaterThanOrEqual(1)
    expect(health.totals.sent).toBeGreaterThanOrEqual(1)
    expect(health.queue).toEqual({
      pending: 0,
      pendingDue: 0,
      sending: 0,
      failed: 0,
      stuckSendingAgeMinutes: null,
    })
  })

  it("stops polling on stop and reports polling: false", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 50 })
    await worker.start()
    await vi.waitFor(() => {
      expect(mockProcessOutbox).toHaveBeenCalled()
    })
    await worker.stop()
    expect(worker.getHealth().polling).toBe(false)
    const callsAfterStop = mockProcessOutbox.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(mockProcessOutbox.mock.calls.length).toBe(callsAfterStop)
    worker = null
  })

  it("surfaces a failed poll as down with a 503 health endpoint (EML-036, SRC-320)", async () => {
    mockProcessOutbox.mockRejectedValue(new Error("database down"))
    worker = createEmailWorker({ port: 0, pollIntervalMs: 50 })
    await worker.start()
    await vi.waitFor(() => {
      expect(worker!.getHealth().lastError).toBe("database down")
    })
    expect(worker.getHealth().lastRun).toBeNull()
    expect(worker.getHealth().status).toBe("down")
    // The worker is still polling — the next poll retries.
    const res = await fetch(`http://localhost:${worker.getPort()}/health`)
    expect(res.status).toBe(503)
    const health = (await res.json()) as { status: string }
    expect(health.status).toBe("down")
  })

  it("runOnce returns the poll result directly", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    const result = await worker.runOnce()
    expect(result).toEqual(SINGLE_RUN)
    expect(mockProcessOutbox).toHaveBeenCalledWith({ limit: 100 })
    expect(mockRescore).toHaveBeenCalledWith({ limit: 100 })
    expect(mockDigest).toHaveBeenCalledWith({ limit: 100 })
    expect(mockExpire).toHaveBeenCalledTimes(1)
    expect(mockExpire.mock.calls[0][0]).toBeInstanceOf(Date)
    expect(mockQueueDepth).toHaveBeenCalled()
  })

  it("accumulates cumulative totals alongside lastRun (EML-036)", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    await worker.runOnce()
    await worker.runOnce()
    const health = worker.getHealth()
    expect(health.lastRun).toEqual(SINGLE_RUN)
    expect(health.totals.processed).toBe(2)
    expect(health.totals.sent).toBe(2)
    expect(health.totals.rescored).toBe(4)
    expect(health.status).toBe("ok")
  })

  it("reports a failed job at error level and degrades health (EML-014, EML-040)", async () => {
    mockProcessOutbox.mockResolvedValue({
      processed: 2,
      sent: 1,
      failed: 1,
      skipped: 0,
    })
    mockRecentFailed.mockResolvedValue([
      {
        id: "job-1",
        type: "SUBMISSION_NOTIFICATION",
        to: "owner@example.com",
        attempts: 2,
        lastError: "No email provider configured",
        nextAttemptAt: null,
        updatedAt: new Date().toISOString(),
      },
    ])
    const capture = captureOutput()
    try {
      worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
      await worker.start()
      await vi.waitFor(() => {
        expect(worker!.getHealth().lastJobError).toBe(
          "No email provider configured"
        )
      })
    } finally {
      capture.restore()
    }
    const health = worker.getHealth()
    expect(health.status).toBe("degraded")
    expect(health.lastRun?.failed).toBe(1)
    expect(health.totals.failed).toBe(1)
    // One JSON line per poll plus one error line naming the job.
    const joined = capture.chunks.join("\n")
    expect(joined).toContain("job-1")
    expect(joined).toContain("No email provider configured")
    expect(joined).toContain("outbox poll complete")
    const res = await fetch(`http://localhost:${worker.getPort()}/health`)
    expect(res.status).toBe(503)
  })

  it("exposes queue depth and warns on a stuck SENDING row (EML-035)", async () => {
    mockQueueDepth.mockResolvedValue({
      pending: 5,
      pendingDue: 3,
      sending: 2,
      failed: 1,
      stuckSendingAgeMinutes: 45,
    })
    const capture = captureOutput()
    try {
      worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
      await worker.start()
      await vi.waitFor(() => {
        expect(worker!.getHealth().queue?.sending).toBe(2)
      })
    } finally {
      capture.restore()
    }
    expect(worker.getHealth().queue).toEqual({
      pending: 5,
      pendingDue: 3,
      sending: 2,
      failed: 1,
      stuckSendingAgeMinutes: 45,
    })
    expect(capture.chunks.join("\n")).toContain("stuck SENDING")
  })

  it("warns when a poll fails every job (EML-035)", async () => {
    mockProcessOutbox.mockResolvedValue({
      processed: 2,
      sent: 0,
      failed: 2,
      skipped: 0,
    })
    const capture = captureOutput()
    try {
      worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
      await worker.runOnce()
    } finally {
      capture.restore()
    }
    expect(capture.chunks.join("\n")).toContain("failed every job")
    expect(worker.getHealth().status).toBe("degraded")
  })

  it("times out a hung poll and keeps polling (EML-037)", async () => {
    mockProcessOutbox.mockImplementation(() => new Promise(() => {}))
    worker = createEmailWorker({
      port: 0,
      pollIntervalMs: 60_000,
      pollTimeoutMs: 50,
    })
    const first = await worker.runOnce()
    expect(first).toEqual({
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
    expect(worker.getHealth().lastError).toMatch(/timed out/)
    expect(worker.getHealth().status).toBe("down")
    expect(mockProcessOutbox).toHaveBeenCalledTimes(1)
    // The watchdog reset the in-flight guard: the next poll runs.
    await worker.runOnce()
    expect(mockProcessOutbox).toHaveBeenCalledTimes(2)
  })

  it("bounds stop() while a poll is hung (SRC-320)", async () => {
    mockProcessOutbox.mockImplementation(() => new Promise(() => {}))
    worker = createEmailWorker({
      port: 0,
      pollIntervalMs: 60_000,
      pollTimeoutMs: 60_000,
      stopTimeoutMs: 50,
    })
    await worker.start()
    const started = Date.now()
    await worker.stop()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(worker.getHealth().polling).toBe(false)
    worker = null
  })
})
