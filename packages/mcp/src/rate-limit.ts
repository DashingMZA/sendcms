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

export async function checkMcpRateLimit(keyId: string): Promise<void> {
  // The limits come from the key owner's effective plan entitlements
  // (Phase 4). The constants are the fallback defaults when the
  // entitlement is null (the plan says "platform default") or the
  // lookup fails — a plans-module error must never block MCP calls.
  let minuteLimit = MCP_MINUTE_LIMIT
  let hourLimit = MCP_HOUR_LIMIT
  try {
    const key = await db.apiKey.findUnique({
      where: { id: keyId },
      select: { userId: true },
    })
    if (key) {
      const effective = await getEffectiveEntitlementsSafe(key.userId)
      if (effective?.entitlements) {
        minuteLimit =
          effective.entitlements.mcpRequestsPerMinute ?? MCP_MINUTE_LIMIT
        hourLimit = effective.entitlements.mcpRequestsPerHour ?? MCP_HOUR_LIMIT
      }
    }
  } catch {
    // Fail-open: the constants apply.
  }
  const now = new Date()
  const minuteStart = new Date(now)
  minuteStart.setSeconds(0, 0)
  const hourStart = new Date(now)
  hourStart.setMinutes(0, 0, 0)

  const row = await db.apiKeyRateLimit.findUnique({
    where: { apiKeyId: keyId },
  })
  const minuteCount =
    row && row.minuteWindowStart.getTime() === minuteStart.getTime()
      ? row.minuteCount + 1
      : 1
  const hourCount =
    row && row.hourWindowStart.getTime() === hourStart.getTime()
      ? row.hourCount + 1
      : 1
  if (minuteCount > minuteLimit) {
    throw new ApiError(
      "Too many MCP requests. Please wait a minute and try again.",
      429
    )
  }
  if (hourCount > hourLimit) {
    throw new ApiError(
      "Too many MCP requests from this key. Try again later.",
      429
    )
  }
  await db.apiKeyRateLimit.upsert({
    where: { apiKeyId: keyId },
    create: {
      apiKeyId: keyId,
      minuteWindowStart: minuteStart,
      minuteCount,
      hourWindowStart: hourStart,
      hourCount,
    },
    update: {
      minuteWindowStart: minuteStart,
      minuteCount,
      hourWindowStart: hourStart,
      hourCount,
    },
  })
}
