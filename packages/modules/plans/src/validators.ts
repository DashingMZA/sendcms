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

// Plans & entitlements (Phase 4) — Zod schemas for every request body
// and list query, plus the typed entitlement config stored on
// PlanVersion.entitlements. Shared by the api routes and the admin UI's
// hooks. Query params arrive as strings, so page/perPage coerce and
// clamp here.

// ─── Plan entitlements ──────────────────────────────────────────────────

// The five AI providers (the same set as packages/ai). A plan's
// aiProviders is the allowlist a subscription on that plan may use.
export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const

export const AiProviderSchema = z.enum(AI_PROVIDERS)

// The typed entitlement config for one plan version. A `null` limit
// means UNLIMITED for that meter — except apiKeys, which is always a
// number (an unbounded key count is an abuse vector), and the MCP
// windows, where `null` means "use the platform default" (the
// MCP_MINUTE_LIMIT / MCP_HOUR_LIMIT constants) rather than unlimited:
// an un-rate-limited MCP endpoint is an abuse vector too.
export const PlanEntitlementsSchema = z
  .object({
    forms: z.number().int().min(0).nullable(),
    domains: z.number().int().min(0).nullable(),
    submissionsPerMonth: z.number().int().min(0).nullable(),
    apiKeys: z.number().int().min(0),
    aiRequestsPerDay: z.number().int().min(0).nullable(),
    mcpRequestsPerMinute: z.number().int().min(0).nullable(),
    mcpRequestsPerHour: z.number().int().min(0).nullable(),
    aiProviders: z.array(AiProviderSchema),
    aiByokAllowed: z.boolean(),
    aiPlatformAllowed: z.boolean(),
    features: z.array(z.string().trim().min(1).max(100)),
  })
  .strict()

export type PlanEntitlements = z.infer<typeof PlanEntitlementsSchema>

// The default Free plan (version 1) mirrors today's hardcoded limits
// exactly, so creating it changes no existing user's behaviour: API
// keys 10, AI 100 calls/day, MCP 120/min + 2000/hour, everything else
// unlimited. Limits are admin-configurable from here on — never
// hardcoded in a service again.
export const FREE_PLAN_V1_ENTITLEMENTS: PlanEntitlements = {
  forms: null,
  domains: null,
  submissionsPerMonth: null,
  apiKeys: 10,
  aiRequestsPerDay: 100,
  mcpRequestsPerMinute: 120,
  mcpRequestsPerHour: 2000,
  aiProviders: ["openai", "anthropic", "google", "deepseek", "openrouter"],
  aiByokAllowed: true,
  aiPlatformAllowed: true,
  features: [],
}

// The meter a UsageLedger row / EntitlementOverride counts.
export const UsageMeterSchema = z.enum([
  "FORMS",
  "DOMAINS",
  "SUBMISSIONS",
  "API_KEYS",
  "MCP_REQUESTS",
  "AI_REQUESTS",
])

export type UsageMeter = z.infer<typeof UsageMeterSchema>

// ─── Shared pagination ──────────────────────────────────────────────────

export const AdminPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── Plan queries ─────────────────────────────────────────────────────

export const PlanListQuerySchema = AdminPaginationQuerySchema.extend({
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
  kind: z.enum(["FREE", "PAID"]).optional(),
  q: z.string().trim().max(200).optional(),
  // ADM-038: exact-slug lookup — the usage page resolves the Free
  // plan by slug instead of paging the list (which breaks past 100
  // plans). Exact match: slugs are unique.
  slug: z.string().trim().min(1).max(200).optional(),
  sort: z
    .enum(["createdAt:desc", "createdAt:asc", "name:asc", "name:desc"])
    .optional()
    .default("createdAt:desc"),
})

export const SubscriptionListQuerySchema = AdminPaginationQuerySchema.extend({
  userId: z.string().trim().min(1).optional(),
  planId: z.string().trim().min(1).optional(),
  status: z
    .enum(["ACTIVE", "TRIALING", "PAST_DUE", "CANCELED", "EXPIRED"])
    .optional(),
  // ADM-032: free-text search over the subscriber's name/email
  // (contains, case-insensitive) — the subscriptions table's search
  // box promises this and previously filtered nothing.
  q: z.string().trim().max(200).optional(),
  sort: z
    .enum(["createdAt:desc", "createdAt:asc"])
    .optional()
    .default("createdAt:desc"),
})

export const UsageQuerySchema = z.object({
  userId: z.string().trim().min(1),
  meter: UsageMeterSchema.optional(),
  // ISO date (YYYY-MM-DD) for the period bucket start; defaults to the
  // current bucket for the meter (month start / day start).
  period: z.string().trim().min(1).optional(),
})

export const EntitlementOverrideListQuerySchema =
  AdminPaginationQuerySchema.extend({
    userId: z.string().trim().min(1).optional(),
    meter: UsageMeterSchema.optional(),
  })

export const PlanVersionCompareQuerySchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
})

// ─── Plan bodies ──────────────────────────────────────────────────────

const PlanPriceSchema = z.object({
  priceAmount: z.number().int().min(0).nullable().optional(),
  // DB-015: ISO 4217 alpha-3, uppercase — matches the
  // PlanVersion_priceCurrency_format CHECK in migration
  // 20261125091719_wave8b_billing_reconciliation. A lowercase or
  // non-3-letter code is rejected here instead of at the DB.
  priceCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 alpha-3 code, e.g. USD")
    .optional(),
  billingInterval: z
    .enum(["MONTHLY", "ANNUAL", "CUSTOM", "ONE_TIME"])
    .optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
})

export const CreatePlanSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    slug: z
      .string()
      .trim()
      .min(1, "Slug is required")
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must be lowercase letters, numbers and hyphens"
      ),
    description: z.string().trim().max(500).optional(),
    kind: z.enum(["FREE", "PAID"]).optional().default("FREE"),
    isPrivate: z.boolean().optional().default(false),
    entitlements: PlanEntitlementsSchema,
    changeReason: z.string().trim().max(500).optional(),
  })
  .merge(PlanPriceSchema)

export const CreatePlanVersionSchema = z
  .object({
    entitlements: PlanEntitlementsSchema,
    changeReason: z.string().trim().max(500).optional(),
  })
  .merge(PlanPriceSchema)

// Publishing a version changes what new subscribers get — a reason is
// required so the audit trail explains the change.
export const PublishPlanVersionSchema = z.object({
  reason: requiredString("Reason is required")
    .trim()
    .min(1, "Reason is required")
    .max(500),
})

export const ArchivePlanSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export const DuplicatePlanSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase letters, numbers and hyphens"
    ),
})

// ─── Subscription bodies ──────────────────────────────────────────────

export const AssignSubscriptionSchema = z.object({
  userId: z.string().trim().min(1),
  planVersionId: z.string().trim().min(1),
  reason: requiredString("Reason is required")
    .trim()
    .min(1, "Reason is required")
    .max(500),
})

export const MigrationPreviewSchema = z
  .object({
    planVersionId: z.string().trim().min(1),
    userIds: z.array(z.string().trim().min(1)).max(1000).optional(),
    allOnVersionId: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.userIds?.length) !== Boolean(v.allOnVersionId), {
    message:
      "Provide either userIds or allOnVersionId, not both and not neither",
  })

export const ExecuteMigrationSchema = z
  .object({
    planVersionId: z.string().trim().min(1),
    // Exactly one of userIds / allOnVersionId (same shape as the
    // preview). allOnVersionId resolves server-side to EVERY active
    // subscription on that version — the preview only shows the first
    // 100, so executing from the previewed ids would silently drop
    // the rest.
    userIds: z.array(z.string().trim().min(1)).max(1000).optional(),
    allOnVersionId: z.string().trim().min(1).optional(),
    reason: requiredString("Reason is required")
      .trim()
      .min(1, "Reason is required")
      .max(500),
  })
  .refine((v) => Boolean(v.userIds?.length) !== Boolean(v.allOnVersionId), {
    message:
      "Provide either userIds or allOnVersionId, not both and not neither",
  })

export const CancelSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().optional().default(false),
  reason: z.string().trim().max(500).optional(),
})

// BIL-120 (Wave 6): the customer free-plan subscribe body — the plan
// version only. The service re-reads the version and refuses anything
// that is not a published free version; the price is never trusted
// from the client.
export const SubscribeFreePlanSchema = z.object({
  planVersionId: z.string().trim().min(1, "planVersionId is required"),
})

// ─── Override bodies ──────────────────────────────────────────────────

export const SetEntitlementOverrideSchema = z.object({
  meter: UsageMeterSchema,
  // null = unlimited for that meter.
  value: z.number().int().min(0).nullable(),
  reason: requiredString("Reason is required")
    .trim()
    .min(1, "Reason is required")
    .max(500),
  expiresAt: z.string().datetime().optional(),
})

export const RecordUsageSchema = z.object({
  userId: z.string().trim().min(1),
  meter: UsageMeterSchema,
  quantity: z.number().int().min(1).optional().default(1),
  unit: z.string().trim().min(1).max(50),
  period: z.string().datetime(),
  sourceEvent: z.string().trim().max(100).optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  resourceId: z.string().trim().min(1).max(200).optional(),
})

// ─── Inferred types ───────────────────────────────────────────────────

export type PlanListQuery = z.infer<typeof PlanListQuerySchema>
export type SubscriptionListQuery = z.infer<typeof SubscriptionListQuerySchema>
export type UsageQuery = z.infer<typeof UsageQuerySchema>
export type EntitlementOverrideListQuery = z.infer<
  typeof EntitlementOverrideListQuerySchema
>
export type PlanVersionCompareQuery = z.infer<
  typeof PlanVersionCompareQuerySchema
>
export type CreatePlanInput = z.infer<typeof CreatePlanSchema>
export type CreatePlanVersionInput = z.infer<typeof CreatePlanVersionSchema>
export type PublishPlanVersionInput = z.infer<typeof PublishPlanVersionSchema>
export type ArchivePlanInput = z.infer<typeof ArchivePlanSchema>
export type DuplicatePlanInput = z.infer<typeof DuplicatePlanSchema>
export type AssignSubscriptionInput = z.infer<typeof AssignSubscriptionSchema>
export type MigrationPreviewInput = z.infer<typeof MigrationPreviewSchema>
export type ExecuteMigrationInput = z.infer<typeof ExecuteMigrationSchema>
// cancelSubscription is called directly as well as through a route, so
// its input type is the pre-default one: `cancelAtPeriodEnd` is optional
// and defaults to false in the service.
export type CancelSubscriptionInput = z.input<typeof CancelSubscriptionSchema>
export type SubscribeFreePlanInput = z.infer<typeof SubscribeFreePlanSchema>
export type SetEntitlementOverrideInput = z.infer<
  typeof SetEntitlementOverrideSchema
>
// recordUsage is called directly by other services (not only through a
// route), so its input type is the pre-default one: `quantity` is
// optional and defaults to 1 in the service.
export type RecordUsageInput = z.input<typeof RecordUsageSchema>
