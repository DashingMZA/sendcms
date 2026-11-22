import { ApiError } from "@sendcms/shared"
import { db } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"
import type { McpAuthContext } from "./auth"

const logger = createLogger("mcp")

// What the MCP endpoint resolved for this request's key: the per-user
// allowlist (null = every tool the key's scope allows) and the
// per-user quota overrides (null = the plan's limits). The route
// passes the allowlist into the server's auth context (registration
// filters on it) and the overrides into the rate limiter.
export type McpAccess = {
  allowedTools: string[] | null
  minuteLimit: number | null
  hourLimit: number | null
}

// The stored allowlist is Json — the admin service only ever writes
// an array of real tool names, so anything else is corrupt data.
// Treat it as "no allowlist" (fail-open to in-scope tools) and log,
// rather than bricking the user's MCP with a confusing 404 per tool.
export function parseMcpAllowedTools(value: unknown): string[] | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[]
  }
  logger.warn("mcp allowlist has an unexpected shape; ignoring it", {
    value,
  })
  return null
}

// The enforcement point for admin MCP controls (Phase 6). The route
// calls this for EVERY MCP request — tools/call with the tool name,
// everything else (initialize, tools/list, ping) without one — so a
// control changed in the admin app takes effect on the next request,
// not just in the UI. Order matters:
//
//   (a) global kill-switch off → 503 (every MCP call refused);
//   (b) key revoked → 401 (already handled by resolveMcpAuth, which
//       returns null for revoked keys before this runs);
//   (c) key owner suspended/disabled → 403 (API-key auth carries no
//       session, so the status is checked explicitly here);
//   (d) per-user MCP disabled → 403;
//   (e) tool not in the user's allowlist → 404 "Tool X not found"
//       (the same message a READ key gets for a mutation — the
//       allowlist itself is never leaked);
//   (f) quota: resolved by the caller from the returned overrides →
//       plan entitlements → platform defaults (rate-limit.ts).
//
// A failure here is a refusal BEFORE execution: it consumes no quota
// and writes no usage row.
export async function checkMcpAccess(input: {
  auth: McpAuthContext
  tool?: string
}): Promise<McpAccess> {
  const { auth, tool } = input

  const settings = await db.mcpSettings.findFirst({
    select: { globalEnabled: true },
  })
  if (settings && !settings.globalEnabled) {
    throw new ApiError(
      "MCP is temporarily disabled by the platform administrator.",
      503
    )
  }

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { status: true },
  })
  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(
      "This account is suspended. MCP access is disabled.",
      403
    )
  }

  const userSettings = await db.mcpUserSettings.findUnique({
    where: { userId: auth.userId },
  })
  if (userSettings && !userSettings.isEnabled) {
    throw new ApiError(
      "MCP is disabled for this account by the platform administrator.",
      403
    )
  }

  const allowedTools = parseMcpAllowedTools(userSettings?.allowedTools ?? null)
  if (
    tool !== undefined &&
    allowedTools !== null &&
    !allowedTools.includes(tool)
  ) {
    throw new ApiError(`Tool ${tool} not found`, 404)
  }

  return {
    allowedTools,
    minuteLimit: userSettings?.minuteLimit ?? null,
    hourLimit: userSettings?.hourLimit ?? null,
  }
}
