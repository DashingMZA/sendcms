// Standalone email worker (Phase 9). Drains the outbox on a timer —
// the alternative to the cron HTTP trigger for deployments that run a
// long-lived process. The PENDING → SENDING claim (packages/queue)
// makes it safe to run alongside the cron route: a job claimed by one
// is skipped by the other. A failed poll (DB down, provider down) never
// kills the worker — the next poll retries, and the health endpoint
// surfaces the last error.
import { createServer, type Server } from "node:http"
import { createLogger } from "@sendcms/observability"
import { processEmailOutbox } from "@sendcms/notifications"
import { rescoreNewSubmissions, sendDueDigests } from "@sendcms/submissions"

const logger = createLogger("email-worker")

export type EmailWorkerOptions = {
  /** Health endpoint port. Env `PORT` (injected by Render/Railway) else `WORKER_PORT`, default 3005. */
  port?: number
  /** Milliseconds between outbox polls. Env `WORKER_POLL_INTERVAL_MS`, default 30_000. */
  pollIntervalMs?: number
  /** Jobs per poll. Default 100 (same as the cron route). */
  batchLimit?: number
}

export type EmailWorkerRun = {
  processed: number
  sent: number
  failed: number
  /** NEW submissions the AI re-scored this poll (0 when AI is off). */
  rescored: number
  /** Of those, how many the model scored at/above the spam threshold. */
  markedSpam: number
  /** Digest emails enqueued this poll (0 when AI is off or none due). */
  digests: number
}

export type EmailWorkerHealth = {
  status: "ok"
  uptimeSeconds: number
  polling: boolean
  lastRunAt: string | null
  lastRun: EmailWorkerRun | null
  lastError: string | null
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export function createEmailWorker(options: EmailWorkerOptions = {}) {
  const port = options.port ?? envInt("PORT", envInt("WORKER_PORT", 3005))
  const pollIntervalMs =
    options.pollIntervalMs ?? envInt("WORKER_POLL_INTERVAL_MS", 30_000)
  const batchLimit = options.batchLimit ?? 100
  const startedAt = Date.now()
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let running: Promise<EmailWorkerRun> | null = null
  let lastRun: EmailWorkerRun | null = null
  let lastRunAt: string | null = null
  let lastError: string | null = null

  async function runOnce(): Promise<EmailWorkerRun> {
    // A poll that is already running is not re-entered — the interval
    // just skips a beat.
    if (running) return running
    running = (async () => {
      try {
        const result = await processEmailOutbox({ limit: batchLimit })
        // AI spam re-scoring (Phase 12, Step 2): same poll, after the
        // outbox drain. A no-op when no provider is configured or no
        // form has AI on — and a failed re-score never fails the poll.
        let rescored = 0
        let markedSpam = 0
        let rescoreError: string | null = null
        try {
          const rescore = await rescoreNewSubmissions({ limit: batchLimit })
          rescored = rescore.checked
          markedSpam = rescore.markedSpam
        } catch (err) {
          rescoreError = err instanceof Error ? err.message : "Unknown error"
          logger.error("ai rescore poll failed", { error: err })
        }
        // AI inbox digest (Phase 12, Step 3): same poll, after the
        // re-scoring. A no-op when no provider is configured, no form
        // has AI on, or no digest is due.
        let digests = 0
        let digestError: string | null = null
        try {
          const digest = await sendDueDigests({ limit: batchLimit })
          digests = digest.sent
        } catch (err) {
          digestError = err instanceof Error ? err.message : "Unknown error"
          logger.error("ai digest poll failed", { error: err })
        }
        lastRun = { ...result, rescored, markedSpam, digests }
        lastRunAt = new Date().toISOString()
        lastError = rescoreError ?? digestError
        return lastRun
      } catch (err) {
        // A failed poll must not kill the worker — the next poll
        // retries. The health endpoint surfaces the error.
        lastError = err instanceof Error ? err.message : "Unknown error"
        logger.error("outbox poll failed", { error: err })
        return {
          processed: 0,
          sent: 0,
          failed: 0,
          rescored: 0,
          markedSpam: 0,
          digests: 0,
        }
      } finally {
        running = null
      }
    })()
    return running
  }

  function getHealth(): EmailWorkerHealth {
    return {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      polling: timer !== null,
      lastRunAt,
      lastRun,
      lastError,
    }
  }

  function getPort(): number {
    const address = server?.address()
    return typeof address === "object" && address !== null ? address.port : port
  }

  async function start(): Promise<void> {
    const httpServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(getHealth()))
        return
      }
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("Not found")
    })
    server = httpServer
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      httpServer.once("error", onError)
      httpServer.listen(port, () => {
        httpServer.removeListener("error", onError)
        resolve()
      })
    })
    // Drain any backlog immediately, then on the interval.
    void runOnce()
    timer = setInterval(() => void runOnce(), pollIntervalMs)
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    // Finish the in-flight poll (if any) before closing — a job that
    // was claimed must be marked sent/failed, never left SENDING.
    if (running) await running
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  }

  return { start, stop, runOnce, getHealth, getPort }
}
