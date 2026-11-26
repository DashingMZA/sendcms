// Wave 9 Stream A — LIVE verification against a scratch DB.
//
// Run with the scratch DATABASE_URL in env (via db-url-scratch.mjs):
//   node db-url-scratch.mjs <tsx> tests/live-wave9-stream-a.ts
//
// Covers, against the REAL worker under tsx and the REAL outbox code:
//  1. EML-001/030/061/090 — one job of each type (notification /
//     digest / reply) drains through the worker; the failure must be
//     the provider error, never `React`.
//  2. EML-031/EML-006 — SIGKILL the worker mid-send (SMTP blackhole):
//     the job stays SENDING with a lease; a restarted worker does NOT
//     retry it inside the lease; once the lease is past (backdated),
//     the next poll retries it exactly once and no row stays SENDING.
//  3. EML-032/EML-060 — worker + a second in-process drain racing
//     over the same due set: every job attempts exactly once, with
//     the 1-minute ladder gap.
//  4. EML-034 + DSH-203 — a FAILED job requeues via the service and
//     the next drain attempts it; a SENDING job is filterable and
//     the delivery-log counts reconcile.
//  5. EML-033 — attempt-1 failures schedule the 1m rung (the full
//     1→6 ladder is unit-tested; the 4h rung is not waited out live).
//
// No provider is configured on purpose: sends fail with the provider
// error, which is the assertion (render must succeed first). All rows
// created here are deleted at the end (probe user/form/submission/
// jobs); the scratch DB itself is dropped by the caller.
import { spawn, type ChildProcess } from "node:child_process"
import { db } from "@sendcms/database"
import { claimDueEmailJobs, markEmailJobFailed } from "@sendcms/queue"
import {
  listEmailJobsForUser,
  processEmailOutbox,
  requeueEmailJob,
} from "@sendcms/notifications"

const TAG = "wave9a-stream-a"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
}

async function main(): Promise<void> {
  const started = Date.now()
  // Seed rows are created inside the try so the finally cleanup runs
  // even if a later step throws.
  let user: { id: string } | null = null
  let form: { id: string; name: string } | null = null
  let submission: { id: string } | null = null
  const jobIds: string[] = []
  try {
    // --- Seed: one owner, one form, one submission (all probe-only).
    user = await db.user.create({
      data: {
        name: "Wave 9A Probe",
        email: `${TAG}-owner-${Date.now()}@example.com`,
        emailVerified: true,
      },
    })
    form = await db.form.create({
      data: { name: "Wave 9A probe form", ownerId: user.id },
    })
    submission = await db.submission.create({
      data: {
        form: { connect: { id: form.id } },
        owner: { connect: { id: user.id } },
        data: { name: "Sara", email: "sara@example.com", message: "Hello" },
        originDomain: "example.com",
      },
    })
    // --- Phase 1: one job of each type, drained in-process.
    const jobs = await db.emailJob.createManyAndReturn({
      data: [
        {
          type: "SUBMISSION_NOTIFICATION",
          to: `${TAG}@example.com`,
          subject: `${TAG} notification`,
          formId: form.id,
          ownerId: user.id,
          submissionId: submission.id,
        },
        {
          type: "DIGEST",
          to: `${TAG}@example.com`,
          subject: `${TAG} digest`,
          formId: form.id,
          ownerId: user.id,
          payload: {
            formName: form.name,
            count: 1,
            summary: "One new submission.",
            highlights: [],
            items: [
              {
                senderName: "Sara",
                snippet: "Hello",
                receivedAt: new Date().toISOString(),
              },
            ],
            inboxUrl: "http://localhost:3002/dashboard/inbox",
            accentColor: "#0891b2",
            footerText: "Digest footer.",
            locale: "en",
          },
        },
        {
          type: "SUBMISSION_REPLY",
          to: "sara@example.com",
          subject: `${TAG} reply`,
          formId: form.id,
          ownerId: user.id,
          submissionId: submission.id,
          payload: {
            formName: form.name,
            body: "Hi Sara, thanks for writing.",
            accentColor: "#0891b2",
            footerText: "Reply footer.",
            locale: "en",
          },
        },
      ],
    })
    jobIds.push(...jobs.map((j) => j.id))
    const r1 = await processEmailOutbox({ limit: 10 })
    console.log("phase1 outbox:", JSON.stringify(r1))
    check(
      "EML-038 phase1 counts reconcile",
      r1.processed === r1.sent + r1.failed && r1.skipped === 0,
      JSON.stringify(r1)
    )
    const after1 = await db.emailJob.findMany({ where: { id: { in: jobIds } } })
    for (const j of after1) {
      check(
        `EML-001 ${j.type} renders (no React error)`,
        (j.lastError ?? "").includes("No email provider") &&
          !(j.lastError ?? "").includes("React"),
        `attempts=${j.attempts} lastError=${j.lastError}`
      )
      check(
        `EML-033 ${j.type} attempt 1 schedules ~1m`,
        j.attempts === 1 &&
          !!j.nextAttemptAt &&
          Math.abs(j.nextAttemptAt.getTime() - (started + 60_000)) < 30_000,
        `nextAttemptAt=${j.nextAttemptAt?.toISOString()}`
      )
    }

    // --- Phase 2: SIGKILL mid-send via an SMTP blackhole.
    // A local TCP server that accepts but never greets: nodemailer's
    // send hangs on the greeting until its timeout.
    const net = await import("node:net")
    const blackhole = net.createServer((socket) => {
      socket.on("error", () => {})
      // Never write anything: the SMTP greeting never arrives.
    })
    await new Promise<void>((resolve) =>
      blackhole.listen(0, "127.0.0.1", resolve)
    )
    const blackholePort = (blackhole.address() as { port: number }).port
    const killJob = await db.emailJob.create({
      data: {
        type: "SUBMISSION_NOTIFICATION",
        to: `${TAG}@example.com`,
        subject: `${TAG} sigkill`,
        formId: form.id,
        ownerId: user.id,
        submissionId: submission.id,
      },
    })
    jobIds.push(killJob.id)
    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      WORKER_PORT: "3109",
      WORKER_POLL_INTERVAL_MS: "2000",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(blackholePort),
      SMTP_USER: "probe",
      SMTP_PASS: "probe",
    }
    delete workerEnv.RESEND_API_KEY
    const startWorker = (): ChildProcess =>
      // Detached process group: `tsx` spawns the real worker as a
      // child node process, so killing the tsx parent alone would
      // orphan it (and the orphan would finish the send). The group
      // kill below takes both down — a true SIGKILL.
      spawn("../../node_modules/.bin/tsx", ["src/index.ts"], {
        cwd: "services/email-worker",
        env: workerEnv,
        stdio: "ignore",
        detached: true,
      })
    async function killWorkerGroup(
      proc: ChildProcess,
      signal: NodeJS.Signals = "SIGKILL"
    ): Promise<void> {
      try {
        if (proc.pid) process.kill(-proc.pid, signal)
      } catch {
        /* already dead */
      }
      proc.kill(signal)
      if (signal === "SIGKILL") {
        // Wait until the health port stops answering: the whole group
        // (tsx parent + node child) must be gone, not just the parent.
        for (let i = 0; i < 20; i++) {
          try {
            await fetch("http://localhost:3109/health")
            await sleep(250)
          } catch {
            return
          }
        }
        throw new Error("worker group did not die after SIGKILL")
      }
      await sleep(1500)
    }
    let worker = startWorker()
    // The worker claims the job on its first poll, then hangs in the
    // SMTP greeting (10 s timeout). Wait until the claim lands, then
    // kill it hard mid-send.
    let claimed = false
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      const row = await db.emailJob.findUnique({ where: { id: killJob.id } })
      if (row?.status === "SENDING") {
        claimed = true
        break
      }
    }
    check("EML-031 worker claimed the job before the kill", claimed)
    const midKill = await db.emailJob.findUnique({ where: { id: killJob.id } })
    console.log(
      "phase2 mid-kill row:",
      JSON.stringify({
        status: midKill?.status,
        attempts: midKill?.attempts,
        claimedAt: midKill?.claimedAt,
      })
    )
    await killWorkerGroup(worker)
    const stranded = await db.emailJob.findUnique({ where: { id: killJob.id } })
    check(
      "EML-031 SIGKILL strands the job in SENDING with a lease",
      stranded?.status === "SENDING" &&
        stranded?.attempts === 1 &&
        !!stranded?.claimedAt,
      `status=${stranded?.status} attempts=${stranded?.attempts} claimedAt=${stranded?.claimedAt?.toISOString()}`
    )
    // Restart without the SMTP blackhole (provider error, fast fail):
    // inside the lease the job must NOT be retried.
    delete workerEnv.SMTP_HOST
    delete workerEnv.SMTP_PORT
    delete workerEnv.SMTP_USER
    delete workerEnv.SMTP_PASS
    worker = startWorker()
    await sleep(5000)
    const health = (await (
      await fetch("http://localhost:3109/health")
    ).json()) as { status: string; lastRun: unknown }
    console.log("phase2 worker health:", JSON.stringify(health))
    const insideLease = await db.emailJob.findUnique({
      where: { id: killJob.id },
    })
    check(
      "EML-031 no retry inside the lease",
      insideLease?.status === "SENDING" && insideLease?.attempts === 1,
      `status=${insideLease?.status} attempts=${insideLease?.attempts}`
    )
    // Backdate the lease past 10 min: the next poll must reclaim it.
    await db.emailJob.update({
      where: { id: killJob.id },
      data: { claimedAt: new Date(Date.now() - 11 * 60_000) },
    })
    await sleep(5000)
    const retried = await db.emailJob.findUnique({ where: { id: killJob.id } })
    check(
      "EML-031 stale SENDING retried exactly once after the lease",
      retried?.status === "PENDING" &&
        retried?.attempts === 2 &&
        !(retried?.lastError ?? "").includes("React"),
      `status=${retried?.status} attempts=${retried?.attempts} lastError=${retried?.lastError}`
    )
    await killWorkerGroup(worker, "SIGTERM")
    await sleep(1000)
    blackhole.close()
    const noSending = await db.emailJob.count({
      where: { id: { in: jobIds }, status: "SENDING" },
    })
    check(
      "EML-031 no row stays SENDING past the lease",
      noSending === 0,
      `sending=${noSending}`
    )

    // --- Phase 3: worker + in-process drain racing the same due set.
    const raceJobs = await db.emailJob.createManyAndReturn({
      data: [1, 2, 3].map((n) => ({
        type: "SUBMISSION_NOTIFICATION" as const,
        to: `${TAG}@example.com`,
        subject: `${TAG} race-${n}`,
        formId: form!.id,
        ownerId: user!.id,
        submissionId: submission!.id,
      })),
    })
    const raceIds = raceJobs.map((j) => j.id)
    jobIds.push(...raceIds)
    worker = startWorker()
    const racer = (async () => {
      for (let i = 0; i < 8; i++) {
        await processEmailOutbox({ limit: 10 }).catch(() => {})
        await sleep(700)
      }
    })()
    await racer
    await sleep(1500)
    await killWorkerGroup(worker, "SIGTERM")
    await sleep(1000)
    const raced = await db.emailJob.findMany({ where: { id: { in: raceIds } } })
    const totalAttempts = raced.reduce((n, j) => n + j.attempts, 0)
    check(
      "EML-032/060 each job attempted exactly once per due window",
      totalAttempts === 3 && raced.every((j) => j.attempts === 1),
      `attempts=[${raced.map((j) => j.attempts).join(",")}]`
    )
    for (const j of raced) {
      const gap = (j.nextAttemptAt?.getTime() ?? 0) - j.updatedAt.getTime()
      check(
        `EML-032 ${j.subject} backoff gap >= 60s`,
        gap >= 55_000,
        `gap=${gap}ms`
      )
    }

    // --- Phase 4: requeue + SENDING filter (live).
    const doomed = raceJobs[0]
    await db.emailJob.update({
      where: { id: doomed.id },
      data: { status: "FAILED", attempts: 6, nextAttemptAt: null },
    })
    const requeued = await requeueEmailJob(user.id, doomed.id)
    check(
      "EML-034 live requeue FAILED → PENDING",
      requeued.status === "PENDING" && requeued.attempts === 0,
      `status=${requeued.status} attempts=${requeued.attempts}`
    )
    const r4 = await processEmailOutbox({ limit: 10 })
    const afterRequeue = await db.emailJob.findUnique({
      where: { id: doomed.id },
    })
    check(
      "EML-034 requeued job attempted by the next drain",
      afterRequeue?.attempts === 1,
      `attempts=${afterRequeue?.attempts} status=${afterRequeue?.status}`
    )
    console.log("phase4 drain:", JSON.stringify(r4))
    const stuck = await db.emailJob.create({
      data: {
        type: "SUBMISSION_NOTIFICATION",
        to: `${TAG}@example.com`,
        subject: `${TAG} stuck-visible`,
        status: "SENDING",
        attempts: 1,
        claimedAt: new Date(Date.now() - 30 * 60_000),
        formId: form.id,
        ownerId: user.id,
        submissionId: submission.id,
      },
    })
    jobIds.push(stuck.id)
    const listed = await listEmailJobsForUser(user.id, { status: "SENDING" })
    check(
      "DSH-203 live ?status=SENDING returns the job",
      listed.items.some((i) => i.id === stuck.id),
      `items=${listed.items.length}`
    )
    check(
      "DSH-203 live counts reconcile",
      listed.counts.all ===
        listed.counts.pending +
          listed.counts.sent +
          listed.counts.failed +
          listed.counts.sending,
      JSON.stringify(listed.counts)
    )
    // The stale-claim arm also picks the seeded SENDING row up.
    const due = await claimDueEmailJobs(100)
    check(
      "EML-031 live claimDueEmailJobs returns the stale SENDING row",
      due.some((j) => j.id === stuck.id),
      `due=${due.length}`
    )
    void markEmailJobFailed
  } finally {
    // Cleanup: only rows this script created.
    if (submission) {
      await db.submissionEvent.deleteMany({
        where: { submissionId: submission.id },
      })
      await db.submission
        .delete({ where: { id: submission.id } })
        .catch(() => {})
    }
    await db.emailJob.deleteMany({ where: { id: { in: jobIds } } })
    if (form) await db.form.delete({ where: { id: form.id } }).catch(() => {})
    if (user) await db.user.delete({ where: { id: user.id } }).catch(() => {})
    const left = await db.emailJob.count({ where: { id: { in: jobIds } } })
    console.log(`cleanup: probe jobs remaining=${left}`)
    console.log(
      `live-test finished in ${((Date.now() - started) / 1000).toFixed(1)}s`
    )
  }
}

main().catch((err) => {
  console.error(
    "live-test FAILED:",
    err instanceof Error ? err.message : String(err)
  )
  process.exit(1)
})
