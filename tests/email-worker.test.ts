// Standalone email worker (Phase 9): the poll loop, the health
// endpoint, and graceful shutdown — with the outbox processor mocked,
// so these tests pin the worker's own behavior.
import { afterEach, describe, expect, it, vi } from "vitest"

const mockProcessOutbox = vi.hoisted(() =>
  vi.fn(async () => ({ processed: 1, sent: 1, failed: 0 }))
)
const mockRescore = vi.hoisted(() =>
  vi.fn(async () => ({ checked: 2, markedSpam: 1, skipped: 0 }))
)
const mockDigest = vi.hoisted(() =>
  vi.fn(async () => ({ sent: 1, skipped: 0 }))
)
vi.mock("@sendcms/notifications", () => ({
  processEmailOutbox: mockProcessOutbox,
}))
vi.mock("@sendcms/submissions", () => ({
  rescoreNewSubmissions: mockRescore,
  sendDueDigests: mockDigest,
}))
import { createEmailWorker } from "@sendcms/email-worker/worker"

let worker: ReturnType<typeof createEmailWorker> | null = null

afterEach(async () => {
  if (worker) {
    await worker.stop()
    worker = null
  }
  vi.clearAllMocks()
  mockProcessOutbox.mockResolvedValue({ processed: 1, sent: 1, failed: 0 })
  mockRescore.mockResolvedValue({ checked: 2, markedSpam: 1, skipped: 0 })
  mockDigest.mockResolvedValue({ sent: 1, skipped: 0 })
})

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
      lastRun: {
        processed: number
        sent: number
        failed: number
        rescored: number
        markedSpam: number
        digests: number
      } | null
      lastError: string | null
    }
    expect(health.status).toBe("ok")
    expect(health.polling).toBe(true)
    expect(health.lastRun).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
      rescored: 2,
      markedSpam: 1,
      digests: 1,
    })
    expect(health.lastError).toBeNull()
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

  it("surfaces a failed poll on the health endpoint without crashing", async () => {
    mockProcessOutbox.mockRejectedValue(new Error("database down"))
    worker = createEmailWorker({ port: 0, pollIntervalMs: 50 })
    await worker.start()
    await vi.waitFor(() => {
      expect(worker!.getHealth().lastError).toBe("database down")
    })
    expect(worker.getHealth().lastRun).toBeNull()
    // The worker is still polling — the next poll retries.
    const res = await fetch(`http://localhost:${worker.getPort()}/health`)
    expect(res.status).toBe(200)
  })

  it("runOnce returns the poll result directly", async () => {
    worker = createEmailWorker({ port: 0, pollIntervalMs: 60_000 })
    const result = await worker.runOnce()
    expect(result).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
      rescored: 2,
      markedSpam: 1,
      digests: 1,
    })
    expect(mockProcessOutbox).toHaveBeenCalledWith({ limit: 100 })
    expect(mockRescore).toHaveBeenCalledWith({ limit: 100 })
    expect(mockDigest).toHaveBeenCalledWith({ limit: 100 })
  })
})
