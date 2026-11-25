// MCP admin controls (Admin Control Plane, Phase 6) — Zod schemas
// for every request body and list query. Shared by the api routes and
// the admin UI's hooks. Query params arrive as strings, so page/perPage
// coerce and clamp here.
//
// Tool names themselves are NOT validated here: the service checks
// them against the canonical 19-tool registry in @sendcms/mcp
// (MCP_TOOL_NAMES) — the list lives in one place, never a second
// copy in this file.
import { z } from "zod"

// ADM-097 / ADM-125: a missing required string must fail with a
// human, field-named message — Zod's default invalid_type text
// ("Invalid input: expected string, received undefined") names no
// field. The `error` callback only overrides invalid_type; too_small
// / too_big keep their own messages.
function requiredString(message: string) {
  return z.string({
    error: (issue) => (issue.code === "invalid_type" ? message : undefined),
  })
}

// Shared pagination for admin list endpoints.
export const McpPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── Global kill-switch ───────────────────────────────────────────────

// `reason` is required — toggling MCP for the whole platform is a
// sensitive action and the audit record must say why.
export const SetMcpSettingsSchema = z.object({
  globalEnabled: z.boolean(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type SetMcpSettingsInput = z.infer<typeof SetMcpSettingsSchema>

// ─── Per-user controls ────────────────────────────────────────────────

// Every field is optional — a PATCH-style partial update; only the
// fields present change. `allowedTools` null = every tool the key's
// scope allows (the allowlist is removed); an explicit list = only
// those tools (empty list = no tools). Quota overrides null = the
// plan's limits. 0 is rejected (a zero quota is not a way to block a
// user — use isEnabled false for that); the service double-checks,
// because server components call it directly without this schema.
export const SetUserMcpSettingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  allowedTools: z
    .array(z.string().trim().min(1).max(100))
    .max(19)
    .nullable()
    .optional(),
  minuteLimit: z.number().int().positive().nullable().optional(),
  hourLimit: z.number().int().positive().nullable().optional(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type SetUserMcpSettingsInput = z.infer<typeof SetUserMcpSettingsSchema>

// ─── Usage reporting ──────────────────────────────────────────────────

export const McpUsageStatusSchema = z.enum(["SUCCESS", "FAILED"])

export const McpUsageListQuerySchema = McpPaginationQuerySchema.extend({
  userId: z.string().trim().min(1).optional(),
  apiKeyId: z.string().trim().min(1).optional(),
  tool: z.string().trim().min(1).max(100).optional(),
  status: McpUsageStatusSchema.optional(),
  // ISO date strings, inclusive bounds.
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type McpUsageListQuery = z.infer<typeof McpUsageListQuerySchema>

export const McpUsageSummaryQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type McpUsageSummaryQuery = z.infer<typeof McpUsageSummaryQuerySchema>

// ─── Key list (ADM-064) ────────────────────────────────────────────

// Filters for the admin keys list: search (key name / owner name /
// owner email), owner, scope, revoked/active. `revoked` arrives as
// a query string ("true"/"false") and coerces to boolean.
export const McpKeysListQuerySchema = McpPaginationQuerySchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  userId: z.string().trim().min(1).optional(),
  scope: z.enum(["READ", "FULL"]).optional(),
  revoked: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true")
    .optional(),
})

export type McpKeysListQuery = z.infer<typeof McpKeysListQuerySchema>

// ─── Key revocation ───────────────────────────────────────────────────

// `reason` is required — revoking a customer's key is a sensitive
// action and the audit record must say why.
export const RevokeMcpKeySchema = z.object({
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type RevokeMcpKeyInput = z.infer<typeof RevokeMcpKeySchema>
