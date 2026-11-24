import type { AdminSession } from "@sendcms/auth"
import { AuditAction, AuditResource, db, Prisma } from "@sendcms/database"
import type { McpUsageStatus } from "@sendcms/database"
import { MCP_TOOL_NAMES, parseMcpAllowedTools } from "@sendcms/mcp"
import { revokeApiKeyForUser } from "@sendcms/api-keys"
import { requireAdmin } from "@sendcms/permissions"
import { getTargetUserOrThrow } from "@sendcms/permissions/target-user"
import { logAudit, requireStepUp } from "@sendcms/security"
import { ApiError } from "@sendcms/shared"
import type {
  McpUsageListQuery,
  McpUsageSummaryQuery,
  SetMcpSettingsInput,
  SetUserMcpSettingsInput,
} from "./validators"

// MCP admin controls (Admin Control Plane, Phase 6).
// Framework-independent (no Next.js imports); only services import
// @sendcms/database. Authorization lives HERE, not in the routes:
// admin functions take the actor's AdminSession first and enforce
// their capability (VIEW_MCP reads, MANAGE_MCP writes).
//
// The core invariants:
// - The global kill-switch, per-user disable, tool allowlist and
//   quota overrides are enforced by the MCP service itself
//   (packages/mcp/src/access.ts + the /api/mcp route), not only by
//   the admin UI. Changing a setting here takes effect on the next
//   MCP request.
// - The kill-switch never touches form submission, the inbox, or any
//   non-MCP service — it only gates the /api/mcp endpoint.
// - Usage rows never contain request arguments or results, only the
//   tool name, the outcome, and the duration.
// - Key material never appears in any response, log, or audit record
//   here: the keys list selects metadata only (no keyHash), and the
//   revoke audit carries the key name + reason, never the key.
// - No owner protection and no self-target ban on MCP settings: an
//   admin disabling MCP for a user (including the owner, including
//   themselves) is a legitimate platform action, unlike suspension
//   (Phase 3), which the owner is protected from. Disabling MCP does
//   not lock anyone out of the dashboard — it only stops their API
//   keys from calling tools.

// ─── Authorization ────────────────────────────────────────────────────

// The admin gate lives in `@sendcms/permissions` (Phase 16, Wave 2 —
// SRC-215 / SRC-411): one implementation for every module, re-exported
// here so existing import paths keep working.
export { getEffectiveRole, requireAdmin } from "@sendcms/permissions"

// The target lookup is the shared helper from
// `@sendcms/permissions/target-user` (imported above).

// ─── Global kill-switch ───────────────────────────────────────────────

// The singleton row's fixed id: the McpSettings table holds ONE row,
// and a constant id is what makes the upsert work (there is no other
// unique key to upsert on).
const MCP_SETTINGS_ID = "platform"

export type McpSettingsRow = {
  globalEnabled: boolean
}

function toMcpSettingsRow(row: { globalEnabled: boolean }): McpSettingsRow {
  return { globalEnabled: row.globalEnabled }
}

/** The platform MCP switch. Missing row = enabled (first read
    creates the row). Reads need VIEW_MCP. */
export async function getMcpSettings(
  actor: AdminSession
): Promise<McpSettingsRow> {
  requireAdmin(actor, "VIEW_MCP")
  const row = await db.mcpSettings.upsert({
    where: { id: MCP_SETTINGS_ID },
    update: {},
    create: { id: MCP_SETTINGS_ID },
    select: { globalEnabled: true },
  })
  return toMcpSettingsRow(row)
}

/** Flips the global kill-switch. MANAGE_MCP, reason required, audited
    with the old/new values. When globalEnabled is false, EVERY MCP
    call is refused with 503 — it never touches anything else. */
export async function setMcpSettings(
  actor: AdminSession,
  input: SetMcpSettingsInput
): Promise<McpSettingsRow> {
  requireAdmin(actor, "MANAGE_MCP")
  // Step-up (Phase 9): the kill-switch is high-impact — the actor
  // re-enters their password first. Checked before the write.
  await requireStepUp(actor)
  const before = await db.mcpSettings.findFirst({
    select: { globalEnabled: true },
  })
  const updated = await db.mcpSettings.upsert({
    where: { id: MCP_SETTINGS_ID },
    update: { globalEnabled: input.globalEnabled },
    create: { id: MCP_SETTINGS_ID, globalEnabled: input.globalEnabled },
    select: { globalEnabled: true },
  })
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.MCP_SETTINGS,
    resourceId: MCP_SETTINGS_ID,
    detail: {
      event: "mcp-global-toggled",
      reason: input.reason,
      oldGlobalEnabled: before?.globalEnabled ?? true,
      newGlobalEnabled: updated.globalEnabled,
    },
  })
  return toMcpSettingsRow(updated)
}

// ─── Per-user controls ────────────────────────────────────────────────

export type UserMcpSettingsRow = {
  userId: string
  isEnabled: boolean
  allowedTools: string[] | null
  minuteLimit: number | null
  hourLimit: number | null
}

const DEFAULT_USER_SETTINGS: Omit<UserMcpSettingsRow, "userId"> = {
  isEnabled: true,
  allowedTools: null,
  minuteLimit: null,
  hourLimit: null,
}

function toUserMcpSettingsRow(
  userId: string,
  row: {
    isEnabled: boolean
    allowedTools: Prisma.JsonValue | null
    minuteLimit: number | null
    hourLimit: number | null
  } | null
): UserMcpSettingsRow {
  if (!row) return { userId, ...DEFAULT_USER_SETTINGS }
  return {
    userId,
    isEnabled: row.isEnabled,
    allowedTools: parseMcpAllowedTools(row.allowedTools),
    minuteLimit: row.minuteLimit,
    hourLimit: row.hourLimit,
  }
}

/** One user's MCP controls, or the defaults when no row exists yet.
    Reads need VIEW_MCP. */
export async function getUserMcpSettings(
  actor: AdminSession,
  userId: string
): Promise<UserMcpSettingsRow> {
  requireAdmin(actor, "VIEW_MCP")
  await getTargetUserOrThrow(userId)
  const row = await db.mcpUserSettings.findUnique({
    where: { userId },
  })
  return toUserMcpSettingsRow(userId, row)
}

// The allowlist may only name real tools — validated against the
// canonical 19-tool registry in @sendcms/mcp, never a second copy.
function validateAllowedTools(allowedTools: string[]): void {
  const unknown = allowedTools.filter(
    (tool) => !(MCP_TOOL_NAMES as readonly string[]).includes(tool)
  )
  if (unknown.length > 0) {
    throw new ApiError(
      `Unknown MCP tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
      422
    )
  }
}

function validateQuotaLimits(input: SetUserMcpSettingsInput): void {
  for (const [name, value] of [
    ["minuteLimit", input.minuteLimit],
    ["hourLimit", input.hourLimit],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value <= 0)
    ) {
      throw new ApiError(
        `${name} must be a positive number of requests, or left unset for the plan's limit. Use the enable switch to block a user, not a zero quota.`,
        422
      )
    }
  }
}

/** Partial update of one user's MCP controls — only the fields
    present change. MANAGE_MCP, reason required, audited with the
    old/new values. An explicit allowedTools null removes the
    allowlist; an explicit empty list blocks every tool. */
export async function setUserMcpSettings(
  actor: AdminSession,
  userId: string,
  input: SetUserMcpSettingsInput
): Promise<UserMcpSettingsRow> {
  requireAdmin(actor, "MANAGE_MCP")
  await getTargetUserOrThrow(userId)
  if (input.allowedTools !== undefined && input.allowedTools !== null) {
    validateAllowedTools(input.allowedTools)
  }
  validateQuotaLimits(input)
  const before = await db.mcpUserSettings.findUnique({
    where: { userId },
  })
  const data: Prisma.McpUserSettingsUpdateInput = {}
  if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled
  if (input.allowedTools !== undefined) {
    data.allowedTools =
      input.allowedTools === null
        ? Prisma.JsonNull
        : (input.allowedTools as Prisma.InputJsonValue)
  }
  if (input.minuteLimit !== undefined) data.minuteLimit = input.minuteLimit
  if (input.hourLimit !== undefined) data.hourLimit = input.hourLimit
  const updated = await db.mcpUserSettings.upsert({
    where: { userId },
    update: data,
    create: {
      userId,
      isEnabled: input.isEnabled ?? true,
      allowedTools:
        input.allowedTools === undefined
          ? undefined
          : input.allowedTools === null
            ? Prisma.JsonNull
            : (input.allowedTools as Prisma.InputJsonValue),
      minuteLimit: input.minuteLimit ?? null,
      hourLimit: input.hourLimit ?? null,
    },
  })
  const beforeRow = toUserMcpSettingsRow(userId, before)
  const afterRow = toUserMcpSettingsRow(userId, updated)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.MCP_SETTINGS,
    resourceId: userId,
    detail: {
      event: "mcp-user-settings-changed",
      reason: input.reason,
      old: beforeRow,
      new: afterRow,
    },
  })
  return afterRow
}

// ─── Usage reporting ──────────────────────────────────────────────────

export type McpUsageRow = {
  id: string
  apiKeyId: string
  apiKey: { id: string; name: string; scope: string } | null
  userId: string
  user: { id: string; name: string | null; email: string } | null
  tool: string
  status: McpUsageStatus
  durationMs: number | null
  createdAt: Date
}

function usageWhere(filters: McpUsageListQuery | McpUsageSummaryQuery) {
  const where: Prisma.McpUsageRecordWhereInput = {}
  if ("userId" in filters && filters.userId) where.userId = filters.userId
  if ("apiKeyId" in filters && filters.apiKeyId) {
    where.apiKeyId = filters.apiKeyId
  }
  if ("tool" in filters && filters.tool) where.tool = filters.tool
  if ("status" in filters && filters.status) where.status = filters.status
  const createdAt: Prisma.DateTimeFilter = {}
  if (filters.from) {
    const d = new Date(filters.from)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (filters.to) {
    const d = new Date(filters.to)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt
  return where
}

/** Paginated tool-call history, newest first. Reads need VIEW_MCP.
    Counts only — no request arguments or results are ever stored. */
export async function listMcpUsage(
  actor: AdminSession,
  filters: McpUsageListQuery
): Promise<{
  usage: McpUsageRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_MCP")
  const where = usageWhere(filters)
  const [total, rows] = await Promise.all([
    db.mcpUsageRecord.count({ where }),
    db.mcpUsageRecord.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        apiKey: { select: { id: true, name: true, scope: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
    }),
  ])
  return {
    usage: rows.map((r) => ({
      id: r.id,
      apiKeyId: r.apiKeyId,
      apiKey: r.apiKey,
      userId: r.userId,
      user: r.user,
      tool: r.tool,
      status: r.status,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
    })),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.max(1, Math.ceil(total / filters.perPage)),
  }
}

export type McpUsageSummary = {
  total: number
  success: number
  failed: number
  // Share of calls in the last 24h that failed (0 when none).
  errorRate24h: number
  byTool: { tool: string; calls: number; success: number; failed: number }[]
  topUsers: {
    userId: string
    name: string | null
    email: string
    calls: number
  }[]
}

/** Totals + per-tool counts + top 10 users + the last-24h error rate.
    Counts only. Reads need VIEW_MCP. */
export async function getMcpUsageSummary(
  actor: AdminSession,
  filters: McpUsageSummaryQuery
): Promise<McpUsageSummary> {
  requireAdmin(actor, "VIEW_MCP")
  const where = usageWhere(filters)
  const [byStatus, byToolStatus, byUser, last24h] = await Promise.all([
    db.mcpUsageRecord.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
    db.mcpUsageRecord.groupBy({
      by: ["tool", "status"],
      where,
      _count: { _all: true },
    }),
    db.mcpUsageRecord.groupBy({
      by: ["userId"],
      where,
      _count: { _all: true },
      // The grouped field's count IS the group's size, so ordering
      // by it gives the top users. (`_all` is not a valid order key
      // in the count-order input.)
      orderBy: { _count: { userId: "desc" } },
      take: 10,
    }),
    db.mcpUsageRecord.groupBy({
      by: ["status"],
      where: {
        ...where,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      _count: { _all: true },
    }),
  ])
  let total = 0
  let success = 0
  let failed = 0
  for (const g of byStatus) {
    total += g._count._all
    if (g.status === "SUCCESS") success += g._count._all
    if (g.status === "FAILED") failed += g._count._all
  }
  const toolMap = new Map<
    string,
    { tool: string; calls: number; success: number; failed: number }
  >()
  for (const g of byToolStatus) {
    const bucket = toolMap.get(g.tool) ?? {
      tool: g.tool,
      calls: 0,
      success: 0,
      failed: 0,
    }
    bucket.calls += g._count._all
    if (g.status === "SUCCESS") bucket.success += g._count._all
    if (g.status === "FAILED") bucket.failed += g._count._all
    toolMap.set(g.tool, bucket)
  }
  const byTool = [...toolMap.values()].sort((a, b) => b.calls - a.calls)
  const users = await db.user.findMany({
    where: { id: { in: byUser.map((g) => g.userId) } },
    select: { id: true, name: true, email: true },
  })
  const userById = new Map(users.map((u) => [u.id, u]))
  const topUsers = byUser.map((g) => {
    const user = userById.get(g.userId)
    return {
      userId: g.userId,
      name: user?.name ?? null,
      email: user?.email ?? "unknown",
      calls: g._count._all,
    }
  })
  let last24hTotal = 0
  let last24hFailed = 0
  for (const g of last24h) {
    last24hTotal += g._count._all
    if (g.status === "FAILED") last24hFailed += g._count._all
  }
  return {
    total,
    success,
    failed,
    errorRate24h: last24hTotal === 0 ? 0 : last24hFailed / last24hTotal,
    byTool,
    topUsers,
  }
}

// ─── Keys ─────────────────────────────────────────────────────────────

export type McpKeyRow = {
  id: string
  name: string
  scope: string
  prefix: string
  last4: string
  userId: string
  user: { id: string; name: string | null; email: string } | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  callsLast30Days: number
}

// The keys list never selects keyHash — the plaintext key is
// unrecoverable by design, and the hash must never leave the server.
const mcpKeySelect = {
  id: true,
  name: true,
  scope: true,
  prefix: true,
  last4: true,
  userId: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const

/** Every API key with its owner and its 30-day call count (one
    groupBy, no N+1). Reads need VIEW_MCP. */
export async function listMcpKeys(
  actor: AdminSession,
  page = 1,
  perPage = 20
): Promise<{
  keys: McpKeyRow[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  requireAdmin(actor, "VIEW_MCP")
  const [total, rows, callCounts] = await Promise.all([
    db.apiKey.count(),
    db.apiKey.findMany({
      select: {
        ...mcpKeySelect,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.mcpUsageRecord.groupBy({
      by: ["apiKeyId"],
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { _all: true },
    }),
  ])
  const callsByKey = new Map(callCounts.map((g) => [g.apiKeyId, g._count._all]))
  return {
    keys: rows.map((r) => ({
      ...r,
      callsLast30Days: callsByKey.get(r.id) ?? 0,
    })),
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}

/** Revokes one key. MANAGE_MCP, reason required. Reuses the
    @sendcms/api-keys revoke (which audits the revoke itself as
    DELETE/API_KEY with the key name + scope) and adds the admin
    audit row carrying the reason — the two rows together are the
    complete record: the key-lifecycle event and the admin action
    that caused it. The key stops working immediately. */
export async function revokeMcpKey(
  actor: AdminSession,
  keyId: string,
  reason: string
): Promise<{ revoked: true; keyId: string }> {
  requireAdmin(actor, "MANAGE_MCP")
  const key = await db.apiKey.findUnique({
    where: { id: keyId },
    select: { id: true, userId: true, name: true },
  })
  if (!key) throw new ApiError("API key not found.", 404)
  // Step-up (Phase 9): revoking a key is irreversible for that key —
  // the actor re-enters their password first. Enforced here, at the
  // admin entry point: the dashboard's self-service revoke calls the
  // @sendcms/api-keys primitive directly and is not a step-up action.
  await requireStepUp(actor)
  await revokeApiKeyForUser(key.userId, keyId)
  await logAudit({
    userId: actor.user.id,
    action: AuditAction.DELETE,
    resourceType: AuditResource.API_KEY,
    resourceId: key.id,
    detail: {
      event: "mcp-key-revoked",
      reason,
      ownerId: key.userId,
      name: key.name,
    },
  })
  return { revoked: true as const, keyId: key.id }
}
