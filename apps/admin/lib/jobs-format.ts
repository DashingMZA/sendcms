// Client-safe jobs helpers (Phase C, plan §3.6).
//
// PURE functions with no imports at all: this module is imported by
// client components, so it must never reach a server-only module. The
// two constants below are client-safe COPIES of server values, kept in
// sync by value (see the comments) — never import them from the
// service barrels (@sendcms/notifications / @sendcms/cron), whose
// barrels re-export the services and would drag `db` into the browser
// bundle (the same failure Waves 5 and 6 hit).

/** Claim lease for a SENDING job (Wave 9, EML-031): 10 minutes. Must
    match STALE_CLAIM_LEASE_MINUTES in @sendcms/notifications. A
    SENDING row older than this is stuck and may be requeued. */
export const STALE_CLAIM_LEASE_MINUTES = 10

/** Retry backoff ladder (Wave 9, EML-033): 1m / 5m / 15m / 1h / 4h.
    Must match the queue's ladder in @sendcms/queue. Terminal after
    attempt 6 (MAX_EMAIL_ATTEMPTS). */
export const EMAIL_BACKOFF_LADDER_MINUTES = [1, 5, 15, 60, 240] as const

/** Attempts after which a job is terminal (Wave 9, EML-033). Must
    match MAX_EMAIL_ATTEMPTS in @sendcms/notifications. */
export const MAX_EMAIL_ATTEMPTS = 6

/** Delay in minutes before the next attempt after `attempts` failed
    attempts, or null when the job is terminal (attempts >= 6). */
export function backoffDelayMinutesAfterAttempt(
  attempts: number
): number | null {
  if (attempts >= MAX_EMAIL_ATTEMPTS) return null
  if (attempts < 1) return EMAIL_BACKOFF_LADDER_MINUTES[0]
  return EMAIL_BACKOFF_LADDER_MINUTES[attempts - 1]
}

/** Minutes since a SENDING row was claimed (`claimedAt`, falling back
    to `updatedAt` for rows claimed before the column existed — the
    same fallback the server list uses), never negative. */
export function claimAgeMinutes(
  claimedAt: string | Date | null,
  updatedAt: string | Date,
  now: Date = new Date()
): number {
  const start = claimedAt ?? updatedAt
  const startMs = start instanceof Date ? start.getTime() : Date.parse(start)
  if (Number.isNaN(startMs)) return 0
  return Math.max(0, Math.floor((now.getTime() - startMs) / 60_000))
}

/** Whether the delivery log may offer a requeue for a row: FAILED
    always, SENDING only once it is stuck past the lease. Client
    display only — the service enforces the same rule server-side. */
export function canRequeueJob(
  status: string,
  ageMinutes: number | null
): boolean {
  if (status === "FAILED") return true
  if (status === "SENDING") {
    return (ageMinutes ?? 0) >= STALE_CLAIM_LEASE_MINUTES
  }
  return false
}

/** Split a backoff delay into a display unit: under an hour renders
    in minutes, an hour or more in whole hours. */
export function describeBackoffDelay(minutes: number): {
  value: number
  unit: "minutes" | "hours"
} {
  if (minutes >= 60) return { value: minutes / 60, unit: "hours" }
  return { value: minutes, unit: "minutes" }
}

/** Split a run duration into a display unit: under a second renders
    in milliseconds, otherwise in seconds (one decimal). */
export function describeDuration(ms: number | null): {
  value: number
  unit: "ms" | "seconds"
} | null {
  if (ms === null || ms < 0) return null
  if (ms < 1000) return { value: ms, unit: "ms" }
  return { value: Math.round(ms / 100) / 10, unit: "seconds" }
}
