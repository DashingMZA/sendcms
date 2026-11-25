import { z } from "zod"

// AI provider & BYOK settings (Admin Control Plane, Phase 5) — Zod
// schemas for every request body and list query. Shared by the api
// routes and the dashboard/admin UI's hooks. Query params arrive as
// strings, so page/perPage coerce and clamp here.

// The five AI providers (the same set as packages/ai, lowercase —
// the API speaks lowercase provider names; the service maps them to
// the Prisma AiProvider enum for storage).
export const AI_PROVIDER_NAMES = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
] as const

export const AiProviderNameSchema = z.enum(AI_PROVIDER_NAMES)

// How a user's AI usage is billed. BYOK = their own key (the
// platform key is PAUSED for them while BYOK is selected, until they
// re-enable PLATFORM); PLATFORM = the system's .env key (default);
// DISABLED = no AI for this user.
export const AiBillingModeSchema = z.enum(["BYOK", "PLATFORM", "DISABLED"])

// Shared pagination for admin list endpoints.
export const AiPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── BYOK keys ────────────────────────────────────────────────────────

// Saving a key. Provider keys vary in shape, so the format check is
// deliberately loose (non-empty, min 8 chars) — per-provider prefixes
// are NOT hardcoded. `model` is the user's chosen model for this
// provider (null/omitted = the provider default).
export const SaveAiKeySchema = z.object({
  provider: AiProviderNameSchema,
  apiKey: z.string().trim().min(8, "The API key looks too short.").max(500),
  model: z.string().trim().min(1).max(200).optional(),
})

export type SaveAiKeyInput = z.infer<typeof SaveAiKeySchema>

// Testing a browser-only key: the raw key travels in the request
// body for this one call and is NEVER stored or logged. Same loose
// format check as saving (min 8 chars).
export const TestBrowserKeySchema = z.object({
  apiKey: z.string().trim().min(8, "The API key looks too short.").max(500),
  model: z.string().trim().min(1).max(200).optional(),
})

export type TestBrowserKeyInput = z.infer<typeof TestBrowserKeySchema>

// ─── Browser-only keys (SRC-104) ──────────────────────────────────────

// The per-request browser-only key trio, shared by the AI routes
// (suggest-fields, draft-reply) instead of hand-rolled in each one.
// The key travels in the request body for this one call and is NEVER
// stored or logged. `browserKey` is capped at 500 chars (the routes'
// old inline check); `browserModel` at 200 (same as SaveAiKeySchema).
// An empty/whitespace key counts as absent — the resolver ignores it
// downstream — so only a non-empty key needs its provider.
export const BrowserKeyOptionsSchema = z
  .object({
    browserKey: z
      .string()
      .trim()
      .max(500, "Browser key is too long.")
      .optional(),
    browserProvider: AiProviderNameSchema.optional(),
    browserModel: z.string().trim().max(200).optional(),
  })
  .refine((v) => !v.browserKey || v.browserProvider !== undefined, {
    message: "A browser-only key needs its provider.",
    path: ["browserProvider"],
  })

export type BrowserKeyOptions = z.infer<typeof BrowserKeyOptionsSchema>

/** Parses the browser-only key trio out of a request body. The
    routes' shared replacement for the hand-rolled block SRC-104
    removed: one parse, one error shape, no duplicated provider
    checks. Empty keys/models normalise to `undefined` (absent). */
export function parseBrowserKeyOptions(
  body: unknown
): { ok: true; options: BrowserKeyOptions } | { ok: false; error: string } {
  const parsed = BrowserKeyOptionsSchema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const messages = [
      ...flat.formErrors,
      ...Object.values(flat.fieldErrors).flat(),
    ].filter(Boolean)
    return { ok: false, error: messages.join("; ") || "Validation failed" }
  }
  const { browserKey, browserModel, ...rest } = parsed.data
  return {
    ok: true,
    options: {
      ...rest,
      ...(browserKey ? { browserKey } : {}),
      ...(browserModel ? { browserModel } : {}),
    },
  }
}

// ─── Billing mode ─────────────────────────────────────────────────────

export const SetBillingModeSchema = z.object({
  billingMode: AiBillingModeSchema,
})

export type SetBillingModeInput = z.infer<typeof SetBillingModeSchema>

// ─── Admin provider config ────────────────────────────────────────────

// Full set (POST on the collection). `allowedModels` empty = the
// provider default only. `defaultModel` null = use the platform
// default for that provider (AI_MODEL env or the provider default).
export const SetProviderConfigSchema = z.object({
  provider: AiProviderNameSchema,
  isEnabled: z.boolean(),
  allowedModels: z.array(z.string().trim().min(1).max(200)).max(50),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
})

export type SetProviderConfigInput = z.infer<typeof SetProviderConfigSchema>

// Partial update (PATCH on one provider).
export const UpdateProviderConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  allowedModels: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
})

export type UpdateProviderConfigInput = z.infer<
  typeof UpdateProviderConfigSchema
>

// ─── Admin usage reporting ────────────────────────────────────────────

export const AiUsageStatusSchema = z.enum(["SUCCESS", "FAILED", "RETRY"])

export const AiUsageListQuerySchema = AiPaginationQuerySchema.extend({
  userId: z.string().trim().min(1).optional(),
  provider: AiProviderNameSchema.optional(),
  billingMode: AiBillingModeSchema.optional(),
  status: AiUsageStatusSchema.optional(),
  sourceEvent: z.string().trim().max(100).optional(),
  // ISO date strings, inclusive bounds.
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type AiUsageListQuery = z.infer<typeof AiUsageListQuerySchema>

// Same filters as the list, minus pagination (the summary aggregates).
export const AiUsageSummaryQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  provider: AiProviderNameSchema.optional(),
  billingMode: AiBillingModeSchema.optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type AiUsageSummaryQuery = z.infer<typeof AiUsageSummaryQuerySchema>
