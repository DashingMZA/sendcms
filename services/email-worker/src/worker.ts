// Standalone email worker (Phase 9). Drains the outbox on a timer —
// the alternative to the cron HTTP trigger for deployments that run a
// long-lived process. The PENDING → SENDING claim (packages/queue)
// makes it safe to run alongside the cron route: a job claimed by one
// is skipped by the other. A failed poll (DB down, provider down) never
// kills the worker — the next poll retries, and the health endpoint
// surfaces the last error.
import { createServer, type Server } from "node:http"
import { pingCronHeartbeat, recordWorkerFailedPoll } from "@sendcms/cron"
import { createLogger } from "@sendcms/observability"
import { processEmailOutbox } from "@sendcms/notifications"
import {
  getEmailQueueDepth,
  getRecentFailedEmailJobs,
  type EmailQueueDepth,
} from "@sendcms/platform-ops"
import { expireSubscriptions } from "@sendcms/plans"
import { STALE_CLAIM_LEASE_MINUTES } from "@sendcms/queue"
import { rescoreNewSubmissions, sendDueDigests } from "@sendcms/submissions"

const logger = createLogger("email-worker")

export type EmailWorkerOptions = {
  /** Health endpoint port. Env `PORT` (injected by Render/Railway) else `WORKER_PORT`, default 3005. */
  port?: number
  /** Milliseconds between outbox polls. Env `WORKER_POLL_INTERVAL_MS`, default 30_000. */
  pollIntervalMs?: number
  /** Jobs per poll. Default 100 (same as the cron route). */
  batchLimit?: number
  /** Bound on one whole poll (EML-037). A hung render/send stalls the
      sequential loop, so the race lets the next poll run instead of
      wedging the worker forever. Env `WORKER_POLL_TIMEOUT_MS`,
      default 300_000 (5 min — a healthy 100-job poll can take minutes).
      The per-job 30 s timeout that marks the hung job itself failed
      lives in the processor (Stream A seam — see the Wave 9 report). */
  pollTimeoutMs?: number
  /** Bound on graceful shutdown waiting for an in-flight poll
      (SRC-320). Default 10_000. */
  stopTimeoutMs?: number
}

export type EmailWorkerRun = {
  processed: number
  sent: number
  failed: number
  /** Due jobs another processor claimed first (EML-038): attempted
      counts reconcile as `processed == sent + failed`, and
      `processed + skipped` is the selected batch size. */
  skipped: number
  /** NEW submissions the AI re-scored this poll (0 when AI is off). */
  rescored: number
  /** Of those, how many the model scored at/above the spam threshold. */
  markedSpam: number
  /** Re-score candidates skipped (AI off / flags off / no candidates). */
  rescoreSkipped: number
  /** Digest emails enqueued this poll (0 when AI is off or none due). */
  digests: number
  /** Digest forms skipped (AI off / flags off / none due). */
  digestSkipped: number
  /** Subscriptions expired by this poll (SRC-201). */
  expired: number
  /** Subscriptions canceled at period end by this poll (SRC-201). */
  canceled: number
}

export type EmailWorkerHealth = {
  /** Derived from state (EML-036 / SRC-320): `ok` when the last poll
      was clean, `degraded` when a poll-level error is set or the last
      poll failed jobs, `down` when no poll has ever succeeded or the
      last three polls failed. The HTTP endpoint answers 503 unless
      the status is `ok`. */
  status: "ok" | "degraded" | "down"
  uptimeSeconds: number
  polling: boolean
  lastRunAt: string | null
  lastRun: EmailWorkerRun | null
  /** Cumulative counts since start (EML-036): `lastRun` alone forgets
      a processed job within one poll interval. */
  totals: EmailWorkerRun
  /** Last poll-level error (DB down, timed-out poll, …). */
  lastError: string | null
  /** Most recent job failure (EML-014), distinct from poll errors. */
  lastJobError: string | null
  lastSuccessAt: string | null
  consecutiveFailedPolls: number
  /** Queue depth (EML-035): PENDING due / SENDING / FAILED counts +
      stuck-claim age, as read at the START of the last poll. Null
      until the first poll reads it. */
  queue: EmailQueueDepth | null
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function zeroRun(): EmailWorkerRun {
  return {
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
  }
}

export function createEmailWorker(options: EmailWorkerOptions = {}) {
  const port = options.port ?? envInt("PORT", envInt("WORKER_PORT", 3005))
  const pollIntervalMs =
    options.pollIntervalMs ?? envInt("WORKER_POLL_INTERVAL_MS", 30_000)
  const batchLimit = options.batchLimit ?? 100
  const pollTimeoutMs =
    options.pollTimeoutMs ?? envInt("WORKER_POLL_TIMEOUT_MS", 300_000)
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000
  const startedAt = Date.now()
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let running: Promise<EmailWorkerRun> | null = null
  let pollSeq = 0
  let lastRun: EmailWorkerRun | null = null
  let lastRunAt: string | null = null
  let lastError: string | null = null
  let lastJobError: string | null = null
  let lastSuccessAt: number | null = null
  let consecutiveFailedPolls = 0
  let totals: EmailWorkerRun = zeroRun()
  let queue: EmailQueueDepth | null = null

  /** One poll's outcome, plus the pieces the health endpoint reports
      that the run counts alone do not carry. */
  type PollOutcome = {
    run: EmailWorkerRun
    stepError: string | null
    lastJobError: string | null
    queueDepth: EmailQueueDepth | null
  }

  /** Per-poll outcome reporting (EML-014 / EML-035 / EML-040):
      one error line per failed job, and a warning on a 100%-failed
      poll or a SENDING row older than the claim lease. Best-effort —
      a failing read never fails the poll. The queue depth is passed
      in (read before the drain, so a stuck row is surfaced even when
      the drain reaps it in the same poll). */
  async function reportPollOutcomes(
    run: EmailWorkerRun,
    pollStartedAt: Date,
    queueDepth: EmailQueueDepth | null
  ): Promise<string | null> {
    let jobError: string | null = null
    if (run.failed > 0) {
      try {
        const failedJobs = await getRecentFailedEmailJobs(pollStartedAt)
        for (const job of failedJobs) {
          logger.error("email job failed", {
            jobId: job.id,
            type: job.type,
            to: job.to,
            attempts: job.attempts,
            error: job.lastError,
            nextAttemptAt: job.nextAttemptAt,
          })
        }
        jobError =
          failedJobs[0]?.lastError ??
          `${run.failed} job(s) failed in the last poll`
        if (failedJobs.length === 0) {
          logger.error("outbox poll failed jobs", {
            processed: run.processed,
            sent: run.sent,
            failed: run.failed,
          })
        }
      } catch (err) {
        logger.error("failed to read recent failed jobs", { error: err })
        jobError = `${run.failed} job(s) failed in the last poll`
      }
    }
    if (queueDepth !== null) {
      if (run.processed > 0 && run.failed === run.processed && run.sent === 0) {
        logger.warn("outbox poll failed every job", {
          processed: run.processed,
          failed: run.failed,
        })
      }
      if (
        queueDepth.stuckSendingAgeMinutes !== null &&
        queueDepth.stuckSendingAgeMinutes >= STALE_CLAIM_LEASE_MINUTES
      ) {
        logger.warn("stuck SENDING email jobs", {
          sending: queueDepth.sending,
          stuckSendingAgeMinutes: queueDepth.stuckSendingAgeMinutes,
          leaseMinutes: STALE_CLAIM_LEASE_MINUTES,
        })
      }
    }
    return jobError
  }

  /** The poll itself: outbox drain, then the three background steps.
      A step failure is recorded, never thrown — only the outbox drain
      throwing fails the poll. Returns the outcome; the caller writes
      the state, so a poll that loses the timeout race writes nothing. */
  async function doPoll(pollStartedAt: Date): Promise<PollOutcome> {
    // EML-035: the queue depth is read BEFORE the drain, so a
    // SENDING row that aged past the lease is surfaced even when the
    // drain reaps it in the same poll. Best-effort — a failing read
    // never fails the poll.
    let queueDepth: EmailQueueDepth | null = null
    try {
      queueDepth = await getEmailQueueDepth()
    } catch (err) {
      logger.warn("failed to read email queue depth", { error: err })
    }
    const result = await processEmailOutbox({ limit: batchLimit })
    // AI spam re-scoring (Phase 12, Step 2): same poll, after the
    // outbox drain. A no-op when no provider is configured or no
    // form has AI on — and a failed re-score never fails the poll.
    let rescored = 0
    let markedSpam = 0
    let rescoreSkipped = 0
    let rescoreError: string | null = null
    try {
      const rescore = await rescoreNewSubmissions({ limit: batchLimit })
      rescored = rescore.checked
      markedSpam = rescore.markedSpam
      rescoreSkipped = rescore.skipped
    } catch (err) {
      rescoreError = err instanceof Error ? err.message : "Unknown error"
      logger.error("ai rescore poll failed", { error: err })
    }
    // AI inbox digest (Phase 12, Step 3): same poll, after the
    // re-scoring. A no-op when no provider is configured, no form
    // has AI on, or no digest is due.
    let digests = 0
    let digestSkipped = 0
    let digestError: string | null = null
    try {
      const digest = await sendDueDigests({ limit: batchLimit })
      digests = digest.sent
      digestSkipped = digest.skipped
    } catch (err) {
      digestError = err instanceof Error ? err.message : "Unknown error"
      logger.error("ai digest poll failed", { error: err })
    }
    // Subscription expiry (SRC-201, Wave 9): due subscriptions past
    // their period end flip to EXPIRED / CANCELED here as well as on
    // the cron route, so a long-lived worker deployment expires them
    // without waiting for the daily cron.
    let expired = 0
    let canceled = 0
    let expiryError: string | null = null
    try {
      const outcomes = await expireSubscriptions(new Date())
      expired = outcomes.filter((o) => o.toStatus === "EXPIRED").length
      canceled = outcomes.filter((o) => o.toStatus === "CANCELED").length
    } catch (err) {
      expiryError = err instanceof Error ? err.message : "Unknown error"
      logger.error("subscription expiry poll failed", { error: err })
    }
    const run: EmailWorkerRun = {
      ...result,
      rescored,
      markedSpam,
      rescoreSkipped,
      digests,
      digestSkipped,
      expired,
      canceled,
    }
    const stepError = rescoreError ?? digestError ?? expiryError
    const lastJobError = await reportPollOutcomes(
      run,
      pollStartedAt,
      queueDepth
    )
    return { run, stepError, lastJobError, queueDepth }
  }

  function finishPoll(outcome: PollOutcome, started: number): EmailWorkerRun {
    const { run, stepError, lastJobError: jobError, queueDepth } = outcome
    lastRun = run
    lastRunAt = new Date().toISOString()
    lastSuccessAt = Date.now()
    consecutiveFailedPolls = 0
    lastError = stepError
    lastJobError = jobError
    queue = queueDepth
    totals = {
      processed: totals.processed + run.processed,
      sent: totals.sent + run.sent,
      failed: totals.failed + run.failed,
      skipped: totals.skipped + run.skipped,
      rescored: totals.rescored + run.rescored,
      markedSpam: totals.markedSpam + run.markedSpam,
      rescoreSkipped: totals.rescoreSkipped + run.rescoreSkipped,
      digests: totals.digests + run.digests,
      digestSkipped: totals.digestSkipped + run.digestSkipped,
      expired: totals.expired + run.expired,
      canceled: totals.canceled + run.canceled,
    }
    // EML-040: one JSON line per poll, with the counts.
    logger.info("outbox poll complete", {
      processed: run.processed,
      sent: run.sent,
      failed: run.failed,
      skipped: run.skipped,
      rescored: run.rescored,
      markedSpam: run.markedSpam,
      digests: run.digests,
      expired: run.expired,
      canceled: run.canceled,
      durationMs: Date.now() - started,
    })
    // PRF-018: the poll completed — tell the dead-man's-switch
    // monitor. Fire-and-forget (the `void` precedent of
    // recordWorkerFailedPoll below): the worker is long-lived, so the
    // bounded ping completes, and a failed ping must never fail a
    // poll that already succeeded.
    void pingCronHeartbeat("worker")
    return run
  }

  function failPoll(err: unknown, started: number): EmailWorkerRun {
    // A failed poll must not kill the worker — the next poll
    // retries. The health endpoint surfaces the error.
    lastError = err instanceof Error ? err.message : "Unknown error"
    consecutiveFailedPolls += 1
    logger.error("outbox poll failed", {
      error: err,
      durationMs: Date.now() - started,
    })
    // Seven admin pages, Phase C — Jobs (plan §3.6, Q8): a failed
    // poll writes ONE CronRun row (trigger WORKER, status FAILED).
    // Successful polls write nothing — a row per 30 s poll would be
    // ~2,880 rows/day. `recordWorkerFailedPoll` is best-effort and
    // never throws, so this cannot kill the worker; the health
    // endpoint already surfaces the poll error.
    void recordWorkerFailedPoll({
      error: lastError,
      startedAt: new Date(started),
      durationMs: Date.now() - started,
    })
    return zeroRun()
  }

  async function runOnce(): Promise<EmailWorkerRun> {
    // A poll that is already running is not re-entered — the interval
    // just skips a beat.
    if (running) return running
    const seq = ++pollSeq
    const started = Date.now()
    let timedOut = false
    let timeoutId: NodeJS.Timeout | undefined
    const work = doPoll(new Date(started))
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        reject(new Error(`outbox poll timed out after ${pollTimeoutMs}ms`))
      }, pollTimeoutMs)
    })
    // A timed-out poll keeps running in the background (its send
    // cannot be cancelled); when it eventually settles, say so. The
    // state write below is the only writer and the race already
    // settled, so a late poll can never overwrite a newer poll.
    void work.then(
      () => {
        if (!timedOut) return
        if (seq !== pollSeq) {
          logger.warn("stale outbox poll completed after timeout", {
            pollSeq: seq,
          })
        } else {
          logger.info("timed-out outbox poll eventually completed", {
            pollSeq: seq,
            durationMs: Date.now() - started,
          })
        }
      },
      (err) => {
        if (timedOut && seq === pollSeq) {
          logger.error("timed-out outbox poll failed", { error: err })
        }
      }
    )
    running = Promise.race([work, timeout]).then(
      (outcome) => {
        clearTimeout(timeoutId)
        try {
          return finishPoll(outcome, started)
        } finally {
          running = null
        }
      },
      (err) => {
        clearTimeout(timeoutId)
        try {
          return failPoll(err, started)
        } finally {
          running = null
        }
      }
    )
    return running
  }

  function deriveStatus(): EmailWorkerHealth["status"] {
    // SRC-320: no successful poll ever (DB unreachable from the
    // start) is down, not ok. EML-036: a poll-level error or job
    // failures degrade; three failed polls in a row are down.
    if (lastSuccessAt === null) return "down"
    if (consecutiveFailedPolls >= 3) return "down"
    if (lastError !== null || lastJobError !== null) return "degraded"
    return "ok"
  }

  function getHealth(): EmailWorkerHealth {
    return {
      status: deriveStatus(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      polling: timer !== null,
      lastRunAt,
      lastRun,
      totals,
      lastError,
      lastJobError,
      lastSuccessAt:
        lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
      consecutiveFailedPolls,
      queue,
    }
  }

  function getPort(): number {
    const address = server?.address()
    return typeof address === "object" && address !== null ? address.port : port
  }

  async function start(): Promise<void> {
    const httpServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const health = getHealth()
        res.writeHead(health.status === "ok" ? 200 : 503, {
          "content-type": "application/json",
        })
        res.end(JSON.stringify(health))
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
    // SRC-320: bounded — a hung poll (EML-037) must not block
    // shutdown until the platform SIGKILLs the process.
    if (running) {
      const done = await Promise.race([
        running.then(() => "done" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), stopTimeoutMs)
        ),
      ])
      if (done === "timeout") {
        logger.warn("stop timed out waiting for in-flight poll", {
          stopTimeoutMs,
        })
      }
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  }

  return { start, stop, runOnce, getHealth, getPort }
}
