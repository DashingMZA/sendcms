import { ApiError } from "@sendcms/shared"
import { db } from "@sendcms/database"
import { getEffectiveEntitlementsSafe } from "@sendcms/plans"

// DB-backed rate limits for the MCP endpoint (the public submit's
// counting pattern, not in-memory state — safe across isolates). One
// row per key, two fixed windows (minute + hour); the row is created
// lazily on the key's first MCP call. A call over the limit is rejected
// WITHOUT incrementing the counter, so the key stays limited until the
// window passes.
export const MCP_MINUTE_LIMIT = 120
export const MCP_HOUR_LIMIT = 2000

/** UTC window starts (SRC-310 remainder — Wave 1's AIM-007 fix
    made the claim atomic, but the windows stayed local-time).
    `setSeconds(0,0)` / `setMinutes(0,0,0)` use the server's local
    timezone, so two instances in different timezones split one
    wall-clock minute into different buckets. UTC getters make the
    bucket identical on every instance, in every timezone. Pure,
    so tests can pin the bucket for a fixed instant. */
export function startOfUtcMinute(at: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours(),
      at.getUTCMinutes()
    )
  )
}

export function startOfUtcHour(at: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours()
    )
  )
}

export async function checkMcpRateLimit(
  keyId: string,
  // Per-user quota overrides from the admin MCP controls (Phase 6).
  // A non-null override wins over the plan entitlements; null means
  // "no override — use the plan". The route passes the overrides
  // checkMcpAccess resolved; direct callers omit them and get the
  // plan/default behaviour.
  overrides?: { minuteLimit?: number | null; hourLimit?: number | null }
): Promise<void> {
  // The limits come from the key owner's effective plan entitlements
  // (Phase 4), unless an admin set a per-user override (Phase 6).
  // The constants are the fallback defaults when the entitlement is
  // null (the plan says "platform default") or the lookup fails — a
  // plans-module error must never block MCP calls.
  let minuteLimit: number | null = overrides?.minuteLimit ?? null
  let hourLimit: number | null = overrides?.hourLimit ?? null
  if (minuteLimit === null || hourLimit === null) {
    try {
      const key = await db.apiKey.findUnique({
        where: { id: keyId },
        select: { userId: true },
      })
      if (key) {
        const effective = await getEffectiveEntitlementsSafe(key.userId)
        if (effective?.entitlements) {
          minuteLimit ??=
            effective.entitlements.mcpRequestsPerMinute ?? MCP_MINUTE_LIMIT
          hourLimit ??=
            effective.entitlements.mcpRequestsPerHour ?? MCP_HOUR_LIMIT
        }
      }
    } catch {
      // Fail-open: the constants apply.
    }
  }
  minuteLimit ??= MCP_MINUTE_LIMIT
  hourLimit ??= MCP_HOUR_LIMIT
  // SRC-310: UTC window starts (see startOfUtcMinute/Hour above) —
  // the old local-time starts split one wall-clock minute into two
  // buckets across instances in different timezones.
  const now = new Date()
  const minuteStart = startOfUtcMinute(now)
  const hourStart = startOfUtcHour(now)

  // AIM-007: the counter MUST be claimed atomically. The old code
  // read the row, computed count+1 in memory, then upserted — N
  // concurrent calls all read the same count and all wrote count+1,
  // so a 150-call burst against a 120/min limit sailed through with
  // the counter advancing by ~40. The claim below is a single
  // conditional UPDATE (insert-if-absent first): the WHERE pins both
  // window starts AND requires both counts under their limits, so two
  // concurrent claims serialize on the row — the second sees the
  // first's increment in its own WHERE. Exactly `limit` calls are
  // admitted per window, and a denied call increments nothing, so the
  // stored counter always equals the admitted count. A window that
  // rolled over is reset by its own atomic UPDATE, then the claim is
  // retried; when nothing resets, the windows are current and a limit
  // is genuinely reached.
  await db.apiKeyRateLimit.upsert({
    where: { apiKeyId: keyId },
    create: {
      apiKeyId: keyId,
      minuteWindowStart: minuteStart,
      minuteCount: 0,
      hourWindowStart: hourStart,
      hourCount: 0,
    },
    // No-op touch: the row already exists; the windows/counts are
    // managed by the conditional UPDATEs below, never by this upsert.
    update: { updatedAt: new Date() },
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await db.apiKeyRateLimit.updateMany({
      where: {
        apiKeyId: keyId,
        minuteWindowStart: minuteStart,
        minuteCount: { lt: minuteLimit },
        hourWindowStart: hourStart,
        hourCount: { lt: hourLimit },
      },
      data: {
        minuteCount: { increment: 1 },
        hourCount: { increment: 1 },
      },
    })
    if (claimed.count === 1) return
    // The reset is FORWARD-ONLY ({ lt: minuteStart }, never { not: }):
    // a request whose `now` was captured in minute M but is processed
    // after the rollover must NOT rewind the row to M. With { not: },
    // such a stale request reset the counter to 0 mid-burst (live
    // burst 2026-11-25: 61 calls admitted in wall-clock minute 10:07
    // while minuteCount read 17 — the count had been zeroed by stale
    // resets, so the 120/min cap stopped meaning anything and 21
    // calls were denied that a correct per-minute cap would admit).
    // With { lt: }, the stale request's retry claim still fails (its
    // WHERE pins the old minute) and it is denied after its retries
    // instead of corrupting the new window's count.
    const resetMinute = await db.apiKeyRateLimit.updateMany({
      where: { apiKeyId: keyId, minuteWindowStart: { lt: minuteStart } },
      data: { minuteWindowStart: minuteStart, minuteCount: 0 },
    })
    const resetHour = await db.apiKeyRateLimit.updateMany({
      where: { apiKeyId: keyId, hourWindowStart: { lt: hourStart } },
      data: { hourWindowStart: hourStart, hourCount: 0 },
    })
    if (resetMinute.count === 0 && resetHour.count === 0) {
      // Both windows are current, so the claim failed on a limit, not
      // a rollover. Re-read once to report which limit was hit (a
      // plain read: the counts can only have grown since the claim,
      // so the verdict is stable).
      const current = await db.apiKeyRateLimit.findUnique({
        where: { apiKeyId: keyId },
      })
      if (
        current &&
        current.minuteWindowStart.getTime() === minuteStart.getTime() &&
        current.minuteCount >= minuteLimit
      ) {
        throw new ApiError(
          "Too many MCP requests. Please wait a minute and try again.",
          429
        )
      }
      throw new ApiError(
        "Too many MCP requests from this key. Try again later.",
        429
      )
    }
  }
  // A window reset but the retry still never claimed (a zero limit, or
  // a pathological race) — deny rather than admit.
  throw new ApiError(
    "Too many MCP requests. Please wait a minute and try again.",
    429
  )
}
