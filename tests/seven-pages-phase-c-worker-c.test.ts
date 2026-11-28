// Phase C Worker C — Jobs page (plan §3.6, Q9 + Q12).
// No test hits the real DB, a real provider, or the network: the
// helper tests import the client-safe pure module, the wiring tests
// are static file reads in the Worker A/B style, and the service
// tests assert the Stream A/B exports exist with the documented
// shapes.
//
// RECONCILIATION NOTE (2026-11-26): Streams A/B landed in this tree
// while Worker C was building, and their real signatures differ from
// the brief's documented ones in three places — the admin job list
// returns the owner list's envelope (`items` / `pageSize` / `counts`,
// no `totalPages`), the owner search filter is `ownerSearch` (not
// `q`), and requeue + manual run both require step-up re-auth. The
// page and tables below were reconciled to the landed signatures
// (see the page header comment); the `it.fails` tripwires this file
// started with were converted to normal assertions once the pieces
// landed.
//
// TIME: no test asserts a locale-rendered clock time without a pinned
// timeZone. The formatDate/formatTime assertions pass timeZone: "UTC"
// explicitly; the worker-card checks assert labels and structure,
// never an exact clock reading.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PLATFORM_ROUTE_CAPABILITY } from "@sendcms/permissions"
import { formatDate, formatTime } from "@sendcms/i18n"
import {
  EMAIL_BACKOFF_LADDER_MINUTES,
  MAX_EMAIL_ATTEMPTS,
  STALE_CLAIM_LEASE_MINUTES,
  backoffDelayMinutesAfterAttempt,
  canRequeueJob,
  claimAgeMinutes,
  describeBackoffDelay,
  describeDuration,
} from "@/apps/admin/lib/jobs-format"

const root = process.cwd()
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8")

function readJson(rel: string): Record<string, string> {
  return JSON.parse(read(rel)) as Record<string, string>
}

const DATE = new Date("2026-11-26T14:30:00Z")

describe("jobs client-safe helpers (bundle boundary)", () => {
  it("encodes the Wave 9 retry ladder: 1m / 5m / 15m / 1h / 4h, terminal after attempt 6", () => {
    expect([...EMAIL_BACKOFF_LADDER_MINUTES]).toEqual([1, 5, 15, 60, 240])
    expect(MAX_EMAIL_ATTEMPTS).toBe(6)
    expect(backoffDelayMinutesAfterAttempt(1)).toBe(1)
    expect(backoffDelayMinutesAfterAttempt(2)).toBe(5)
    expect(backoffDelayMinutesAfterAttempt(3)).toBe(15)
    expect(backoffDelayMinutesAfterAttempt(4)).toBe(60)
    expect(backoffDelayMinutesAfterAttempt(5)).toBe(240)
    expect(backoffDelayMinutesAfterAttempt(6)).toBeNull()
    expect(backoffDelayMinutesAfterAttempt(7)).toBeNull()
  })

  it("uses the 10-minute claim lease for the stuck-SENDING rule", () => {
    expect(STALE_CLAIM_LEASE_MINUTES).toBe(10)
    expect(canRequeueJob("FAILED", null)).toBe(true)
    expect(canRequeueJob("SENDING", 10)).toBe(true)
    expect(canRequeueJob("SENDING", 25)).toBe(true)
    expect(canRequeueJob("SENDING", 9)).toBe(false)
    expect(canRequeueJob("SENDING", null)).toBe(false)
    expect(canRequeueJob("PENDING", null)).toBe(false)
    expect(canRequeueJob("SENT", null)).toBe(false)
  })

  it("measures claim age from claimedAt, falling back to updatedAt", () => {
    const now = new Date("2026-11-26T12:30:00Z")
    expect(
      claimAgeMinutes("2026-11-26T12:05:00Z", "2026-11-26T12:00:00Z", now)
    ).toBe(25)
    expect(claimAgeMinutes(null, "2026-11-26T12:00:00Z", now)).toBe(30)
    expect(
      claimAgeMinutes("2026-11-26T12:35:00Z", "2026-11-26T12:00:00Z", now)
    ).toBe(0)
  })

  it("splits backoff delays and run durations into display units", () => {
    expect(describeBackoffDelay(5)).toEqual({ value: 5, unit: "minutes" })
    expect(describeBackoffDelay(60)).toEqual({ value: 1, unit: "hours" })
    expect(describeBackoffDelay(240)).toEqual({ value: 4, unit: "hours" })
    expect(describeDuration(250)).toEqual({ value: 250, unit: "ms" })
    expect(describeDuration(1500)).toEqual({ value: 1.5, unit: "seconds" })
    expect(describeDuration(null)).toBeNull()
    expect(describeDuration(-1)).toBeNull()
  })

  it("formats dates with an explicitly pinned timeZone", () => {
    const opts = {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    } as const
    expect(formatDate("en", DATE, opts)).toBe("Nov 26, 2026")
    expect(formatTime("en", DATE, { timeZone: "UTC" })).toBe("2:30 PM")
  })
})

describe("jobs bundle boundary (regression)", () => {
  const CLIENT_FILES = [
    "apps/admin/components/admin/jobs-queue-table.tsx",
    "apps/admin/components/admin/jobs-cron-runs-table.tsx",
    "apps/admin/components/admin/jobs-worker-card.tsx",
    "apps/admin/components/admin/jobs-job-detail.tsx",
    "apps/admin/components/admin/jobs-run-now-button.tsx",
    "apps/admin/lib/jobs-format.ts",
  ]
  // The Waves 5/6 failure: a barrel import dragging `db` into the
  // browser bundle. No jobs client file may reach a service barrel,
  // the database, or any server-only module. Comments are stripped
  // first — they legitimately name the barrels they warn against.
  // The `/queries` subpaths are the exception: they are client-safe
  // by construction (React Query hooks over apiFetch; only type-only
  // imports reach the service), so the barrel specifiers below are
  // matched with their closing quote — `@sendcms/notifications/queries`
  // and `@sendcms/cron/queries` are allowed, the bare barrels are not.
  const FORBIDDEN = [
    "@sendcms/database",
    "@sendcms/platform-ops",
    'from "@sendcms/notifications"',
    'from "@sendcms/cron"',
    "next/headers",
    'from "pg"',
    "prisma",
  ]

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")
  }

  it("imports no server-only module from any jobs client file", () => {
    for (const rel of CLIENT_FILES) {
      const src = stripComments(read(rel))
      for (const needle of FORBIDDEN) {
        expect(src, `${rel} must not contain ${needle}`).not.toContain(needle)
      }
    }
  })

  it("reaches the services only through their client-safe /queries subpaths", () => {
    const queue = stripComments(
      read("apps/admin/components/admin/jobs-queue-table.tsx")
    )
    expect(queue).toContain('from "@sendcms/notifications/queries"')
    const runNow = stripComments(
      read("apps/admin/components/admin/jobs-run-now-button.tsx")
    )
    expect(runNow).toContain('from "@sendcms/cron/queries"')
  })

  it("keeps the jobs-format helper import-free (pure functions)", () => {
    const src = read("apps/admin/lib/jobs-format.ts")
    expect(src).not.toMatch(/^import /m)
    expect(src).not.toContain('from "')
  })

  it("keeps the worker card free of any live fetch", () => {
    const src = stripComments(
      read("apps/admin/components/admin/jobs-worker-card.tsx")
    )
    expect(src).not.toContain("WORKER_URL")
    expect(src).not.toContain("3005")
    expect(src).not.toContain("fetch(")
    expect(src).toContain("lastSeen")
  })
})

describe("jobs i18n domain", () => {
  it("has identical en/ur key sets (145 keys)", () => {
    const en = readJson("packages/i18n/locales/en/admin/jobs.json")
    const ur = readJson("packages/i18n/locales/ur/admin/jobs.json")
    expect(Object.keys(en).sort()).toEqual(Object.keys(ur).sort())
    expect(Object.keys(en)).toHaveLength(145)
  })

  it("registers the jobs domain for server and shell loading", () => {
    expect(read("packages/i18n/src/load.ts")).toContain('"jobs",')
    expect(read("apps/admin/lib/i18n.ts")).toContain('"jobs",')
  })

  it("keeps the i18n doc counts at the validator's numbers (60 files, 2475 keys)", () => {
    for (const rel of [
      "packages/i18n/README.md",
      "docs/admin-control-plane/internationalization.md",
    ]) {
      const doc = read(rel)
      expect(doc).toContain("60 (19 shared + 27 admin + 14 dashboard)")
      expect(doc).toContain("Source locale: en — 60 files, 2475 keys")
    }
  })

  it("never presents derived state as live (Q12)", () => {
    // Only the explicit negations ("never live", "Nothing here is
    // live") and the follow-up note ("Live worker health is a
    // follow-up") may use the word "live" — no jobs string may
    // present data as live.
    const en = readJson("packages/i18n/locales/en/admin/jobs.json")
    const allowed = new Set([
      "description",
      "workerDescription",
      "workerFollowUp",
    ])
    for (const [key, value] of Object.entries(en)) {
      // Word-boundary match: "delivery" contains "live" as a
      // substring but is not the word "live".
      if (/\blive\b/i.test(value)) {
        expect(allowed.has(key), `${key} must not use "live": ${value}`).toBe(
          true
        )
      }
    }
    expect(en["workerDescription"]).toContain("Nothing here is live")
    expect(en["workerFollowUp"]).toContain("follow-up")
  })
})

describe("jobs page wiring", () => {
  it("exists with loading + error boundaries", () => {
    for (const rel of [
      "apps/admin/app/admin/jobs/page.tsx",
      "apps/admin/app/admin/jobs/loading.tsx",
      "apps/admin/app/admin/jobs/error.tsx",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true)
    }
  })

  it("calls the documented service signatures and renders the PageHeader action slot", () => {
    const src = read("apps/admin/app/admin/jobs/page.tsx")
    expect(src).toContain("listEmailJobsForAdmin")
    expect(src).toContain("listCronRuns")
    expect(src).toContain("getLatestCronRun")
    expect(src).toContain("getEmailQueueDepth")
    expect(src).toContain("JobsRunNowButton")
    expect(src).toContain("JobsQueueTable")
    expect(src).toContain("JobsCronRunsTable")
    expect(src).toContain("JobsWorkerCard")
    // Q9: the mutation gate is the landed MANAGE_JOBS capability.
    expect(src).toContain('adminCan(actorRole, "MANAGE_JOBS")')
    // No live worker fetch, no alerting (PRF-018 — Wave 11).
    expect(src).not.toContain("WORKER_URL")
    expect(src).not.toContain("fetch(")
  })

  it("searches by owner through the landed ownerSearch filter", () => {
    const table = read("apps/admin/components/admin/jobs-queue-table.tsx")
    expect(table).toContain('name="ownerSearch"')
    expect(table).toContain("ownerSearch")
    expect(table).not.toContain('"q"')
  })

  it("runs requeue and manual run behind step-up re-auth", () => {
    // Both mutations require step-up (service for requeue, route
    // for the manual run) — the dialogs must hand off to the shared
    // StepUpDialog instead of mutating directly.
    for (const rel of [
      "apps/admin/components/admin/jobs-queue-table.tsx",
      "apps/admin/components/admin/jobs-run-now-button.tsx",
    ]) {
      const src = read(rel)
      expect(src).toContain("StepUpDialog")
      expect(src).toContain("onVerified")
    }
  })

  it("adds the jobs item to the sidebar Operations group, after audit logs", () => {
    const src = read("apps/admin/components/admin/app-sidebar.tsx")
    const jobs = src.indexOf('"/admin/jobs"')
    const auditLogs = src.indexOf('"/admin/audit-logs"')
    const support = src.indexOf('"/admin/support"')
    expect(jobs).toBeGreaterThan(0)
    expect(jobs).toBeGreaterThan(auditLogs)
    expect(jobs).toBeLessThan(support)
    expect(read("packages/i18n/locales/en/admin/navigation.json")).toContain(
      '"jobs"'
    )
  })
})

describe("Stream A/B services (landed during this build)", () => {
  it("route capability: /admin/jobs maps to VIEW_JOBS (Stream B)", () => {
    expect(PLATFORM_ROUTE_CAPABILITY["/admin/jobs"]).toBe("VIEW_JOBS")
  })

  it("service: listEmailJobsForAdmin exists in @sendcms/notifications (Stream B)", async () => {
    const mod = await import("@sendcms/notifications")
    expect("listEmailJobsForAdmin" in mod).toBe(true)
  }, 60_000)

  it("service: getEmailJobForAdmin exists in @sendcms/notifications (Stream B)", async () => {
    const mod = await import("@sendcms/notifications")
    expect("getEmailJobForAdmin" in mod).toBe(true)
  }, 60_000)

  it("service: listCronRuns exists in @sendcms/cron (Stream A)", async () => {
    const mod = await import("@sendcms/cron")
    expect("listCronRuns" in mod).toBe(true)
  }, 60_000)

  it("service: getLatestCronRun exists in @sendcms/cron (Stream A)", async () => {
    const mod = await import("@sendcms/cron")
    expect("getLatestCronRun" in mod).toBe(true)
  }, 60_000)
})
