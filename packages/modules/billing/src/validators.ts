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
import { BillingProvider } from "@sendcms/database"

const providerSchema = z.nativeEnum(BillingProvider)

const isoCountryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Country codes must be ISO alpha-2, e.g. US, PK, DE")
  .transform((code) => code.toUpperCase())

export const setProviderConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  // null/omitted = everywhere (no mapping rows = all countries);
  // a list restricts the provider to exactly those countries.
  countries: z.array(isoCountryCode).optional(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required"),
})

// POST /admin/billing/providers body: same as the PATCH, plus the
// provider id from the collection route.
export const setProviderConfigBodySchema = setProviderConfigSchema.extend({
  provider: providerSchema,
})

// ADM-123 / BIL-123 / BIL-092: the admin billing-events list —
// paginated, filterable by provider / event type / processed state /
// date. `processed` arrives as a query string ("true" / "false").
// `from`/`to` are ISO date strings, inclusive bounds; the route
// rejects unparseable ones with invalidDateFilterResponse before the
// service runs (same shape as the audit-logs list).
export const BillingEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  provider: providerSchema.optional(),
  eventType: z.string().trim().min(1).max(100).optional(),
  processed: z
    .string()
    .transform((v) => v === "true")
    .optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type BillingEventsQuery = z.infer<typeof BillingEventsQuerySchema>

export const checkoutSessionSchema = z.object({
  planVersionId: z.string().trim().min(1, "planVersionId is required"),
  provider: providerSchema,
  // ISO alpha-2 country of the customer; the page sends the geo-detected
  // or customer-selected code. Optional — without it the country filter
  // is skipped.
  countryCode: isoCountryCode.optional(),
  // BIL-014: client-generated checkout-attempt id (UUID). A retried
  // double-submit reuses the same id, so the provider calls replay
  // the same objects instead of creating duplicates. Omitted → the
  // service generates one and returns it.
  attemptId: z.string().uuid("attemptId must be a UUID").optional(),
})

export type SetProviderConfigInput = z.infer<typeof setProviderConfigSchema>
export type SetProviderConfigBodyInput = z.infer<
  typeof setProviderConfigBodySchema
>
export type CheckoutSessionInput = z.infer<typeof checkoutSessionSchema>
