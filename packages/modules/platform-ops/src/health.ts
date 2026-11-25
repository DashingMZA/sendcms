import type { AdminSession } from "@sendcms/auth"
import { Prisma, RateLimitScope, db, pingDatabase } from "@sendcms/database"
import { readPlatformConfig } from "@sendcms/plans"
import { CSP_REPORT_ONLY, readRateLimitConfig } from "@sendcms/security"
import { requireAdmin } from "./require-admin"

// Platform health + system summary (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Read-only, VIEW_ADMIN_DASHBOARD.
//
// Every number is a real query — there is no fake uptime, no
// synthetic latency, no invented deployment status. The one number
// that cannot come from the database (the Postgres server version)
// comes from `SELECT version()`. Environment values are never
// returned, only presence booleans.

export type PlatformHealth = {
  database: { status: "connected" | "disconnected"; latencyMs: number }
  counts: {
    users: number
    forms: number
    domains: number
    submissionsToday: number
  }
  // EML-092: the outbox as a breakdown, not a single pending count.
  // `pending` is the total PENDING count (kept for compatibility);
  // `pendingDue` is the actionable subset (nextAttemptAt reached or
  // unset). `worker` / `lastCronRunAt` are the observable last drain:
  // the cron route and the standalone worker both drain this queue
  // and neither writes a run record, so the most recently completed
  // job (SENT/FAILED updatedAt) is the last run either of them made.
  outbox: {
    pending: number
    oldestPendingAgeMinutes: number | null
    pendingDue: number
    sending: number
    failed: number
    stuckSendingAgeMinutes: number | null
    worker: { lastRunAt: string | null; lastError: string | null }
    lastCronRunAt: string | null
  }
  ai: { callsToday: number; providersEnabled: number }
  mcp: { callsLast24h: number; errorRate24h: number; globalEnabled: boolean }
  // The Phase 4 platform emergency flag (config/config.json) — the
  // restart-gated kill-switch that also zeroes AI.
  emergency: boolean
  // ADM-124: the live security posture — limiter config straight from
  // config/config.json (never hardcoded) + the calling admin's own
  // ADMIN_API bucket counts for the current windows, and the CSP mode
  // (CSP_REPORT_ONLY) + whether violation reporting is configured
  // (the api + admin proxies pass reportUri to buildCsp).
  securityPosture: {
    rateLimit: {
      config: ReturnType<typeof readRateLimitConfig>
      ownBucket: {
        minuteCount: number
        hourCount: number
        minuteWindowStart: string
        hourWindowStart: string
      } | null
    }
    csp: {
      mode: "enforcing" | "report-only"
      reportingConfigured: boolean
    }
  }
}

// The McpSettings singleton id (Phase 16, ADM-095). This MUST match
// `MCP_SETTINGS_ID` in @sendcms/mcp-admin (packages/modules/
// mcp-admin/src/service.ts), which upserts the row under this id —
// the health read pins to it with findUnique instead of a bare
// findFirst, so a stray second row can never make health report the
// wrong kill-switch state. platform-ops does not depend on mcp-admin,
// so the id is duplicated here by value, not imported; if the
// mcp-admin id ever changes, this must change with it. The regression
// test in tests/platform-ops.test.ts asserts the read is issued
// against exactly this id.
const MCP_SETTINGS_ID = "platform"

/** Live platform health: DB ping, real counts, outbox depth, today's
    AI calls, the last-24h MCP error rate, the MCP kill-switch state,
    and the emergency flag. Reads need VIEW_ADMIN_DASHBOARD. */
export async function getPlatformHealth(
  actor: AdminSession
): Promise<PlatformHealth> {
  requireAdmin(actor, "VIEW_ADMIN_DASHBOARD")
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setUTCHours(0, 0, 0, 0)
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  // The session lookup in auth() already needed the database, so a
  // disconnected ping here is nearly unreachable — but it is still
  // reported honestly instead of throwing.
  let database: PlatformHealth["database"]
  try {
    const ping = await pingDatabase()
    database = { status: "connected", latencyMs: ping.latencyMs }
  } catch {
    database = { status: "disconnected", latencyMs: 0 }
  }

  const [
    userCount,
    formCount,
    domainCount,
    submissionsToday,
    pendingJobs,
    oldestPending,
    pendingDueJobs,
    sendingJobs,
    failedJobs,
    oldestSending,
    lastCompletedJob,
    lastFailedJob,
    ownBucket,
    aiToday,
    providersEnabled,
    mcpLast24h,
    mcpSettings,
  ] = await Promise.all([
    db.user.count(),
    db.form.count(),
    db.domain.count(),
    db.submission.count({ where: { createdAt: { gte: todayStart } } }),
    db.emailJob.count({ where: { status: "PENDING" } }),
    db.emailJob.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    // EML-092: per-status queue counts. A PENDING job is due when its
    // next attempt is unset or already reached.
    db.emailJob.count({
      where: {
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
    }),
    db.emailJob.count({ where: { status: "SENDING" } }),
    db.emailJob.count({ where: { status: "FAILED" } }),
    // A SENDING job is stuck when it was claimed long ago and never
    // completed — the claim path never leaves SENDING behind on
    // purpose, so age here is the stuck signal.
    db.emailJob.findFirst({
      where: { status: "SENDING" },
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
    // Last drain (cron route or standalone worker — same queue, no
    // run record either way): the most recently completed job.
    db.emailJob.findFirst({
      where: { status: { in: ["SENT", "FAILED"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    db.emailJob.findFirst({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, lastError: true },
    }),
    // ADM-124: the calling admin's own ADMIN_API bucket (subject
    // `user:<id>` — see checkAdminApiRateLimit). Read-only: this
    // findUnique never increments the counters. Null when the admin
    // has made no admin-API call in the current windows.
    db.rateLimitBucket.findUnique({
      where: {
        scope_subject: {
          scope: RateLimitScope.ADMIN_API,
          subject: `user:${actor.user.id}`,
        },
      },
    }),
    db.aiDailyUsage.aggregate({
      where: { date: todayStart },
      _sum: { calls: true },
    }),
    db.aiProviderConfig.count({ where: { isEnabled: true } }),
    db.mcpUsageRecord.groupBy({
      by: ["status"],
      where: { createdAt: { gte: dayAgo } },
      _count: { _all: true },
    }),
    db.mcpSettings.findUnique({
      where: { id: MCP_SETTINGS_ID },
      select: { globalEnabled: true },
    }),
  ])

  let mcpTotal = 0
  let mcpFailed = 0
  for (const g of mcpLast24h) {
    mcpTotal += g._count._all
    if (g.status === "FAILED") mcpFailed += g._count._all
  }

  return {
    database,
    counts: {
      users: userCount,
      forms: formCount,
      domains: domainCount,
      submissionsToday,
    },
    outbox: {
      pending: pendingJobs,
      oldestPendingAgeMinutes:
        oldestPending === null
          ? null
          : Math.round(
              (now.getTime() - oldestPending.createdAt.getTime()) / 60000
            ),
      pendingDue: pendingDueJobs,
      sending: sendingJobs,
      failed: failedJobs,
      stuckSendingAgeMinutes:
        oldestSending === null
          ? null
          : Math.round(
              (now.getTime() - oldestSending.updatedAt.getTime()) / 60000
            ),
      worker: {
        lastRunAt: lastCompletedJob
          ? lastCompletedJob.updatedAt.toISOString()
          : null,
        lastError: lastFailedJob?.lastError ?? null,
      },
      lastCronRunAt: lastCompletedJob
        ? lastCompletedJob.updatedAt.toISOString()
        : null,
    },
    ai: {
      callsToday: aiToday._sum.calls ?? 0,
      providersEnabled,
    },
    mcp: {
      callsLast24h: mcpTotal,
      errorRate24h: mcpTotal === 0 ? 0 : mcpFailed / mcpTotal,
      globalEnabled: mcpSettings?.globalEnabled ?? true,
    },
    emergency: readPlatformConfig().emergency,
    securityPosture: {
      rateLimit: {
        config: readRateLimitConfig(),
        ownBucket:
          ownBucket === null
            ? null
            : {
                minuteCount: ownBucket.minuteCount,
                hourCount: ownBucket.hourCount,
                minuteWindowStart: ownBucket.minuteWindowStart.toISOString(),
                hourWindowStart: ownBucket.hourWindowStart.toISOString(),
              },
      },
      csp: {
        mode: CSP_REPORT_ONLY ? "report-only" : "enforcing",
        // The api + admin proxies pass a reportUri to buildCsp
        // (apps/api/proxy.ts, apps/admin/proxy.ts) — violations are
        // reported to /api/csp-report.
        reportingConfigured: true,
      },
    },
  }
}

export type SystemSummary = {
  nodeVersion: string
  postgresVersion: string
  prismaClientVersion: string
  // Presence ONLY — never the values.
  env: {
    databaseUrl: boolean
    betterAuthSecret: boolean
    resendApiKey: boolean
    cronSecret: boolean
    aiByokMasterKey: boolean
  }
  emergency: boolean
}

/** The platform's own facts: runtime versions, which required env
    vars are present, and the config.json emergency flag. Reads need
    VIEW_ADMIN_DASHBOARD. */
export async function getSystemSummary(
  actor: AdminSession
): Promise<SystemSummary> {
  requireAdmin(actor, "VIEW_ADMIN_DASHBOARD")
  const rows = await db.$queryRaw<{ version: string }[]>(
    Prisma.sql`SELECT version() AS version`
  )
  return {
    nodeVersion: process.version,
    postgresVersion: rows[0]?.version ?? "unknown",
    prismaClientVersion: Prisma.prismaVersion.client,
    env: {
      databaseUrl: Boolean(process.env.DATABASE_URL),
      betterAuthSecret: Boolean(process.env.BETTER_AUTH_SECRET),
      resendApiKey: Boolean(process.env.RESEND_API_KEY),
      cronSecret: Boolean(process.env.CRON_SECRET),
      aiByokMasterKey: Boolean(process.env.AI_BYOK_MASTER_KEY),
    },
    emergency: readPlatformConfig().emergency,
  }
}
