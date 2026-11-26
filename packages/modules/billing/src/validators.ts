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

// SRC-230: this file used to import the Prisma `BillingProvider`
// enum as a VALUE (`z.nativeEnum`), so importing
// `@sendcms/billing/validators` (or the `@sendcms/billing` barrel,
// which re-exports these schemas) pulled the Prisma client runtime
// into the bundle. Validators must stay framework-agnostic and safe
// to import anywhere (routes + client hooks), so the provider list
// is a local string enum. The registry
// (`./registry`, BILLING_PROVIDERS) stays the single source of truth
// for what each provider needs — the drift-guard test
// (tests/wave8-stream-d.test.ts) asserts this list, the registry
// ids, and the Prisma enum stay identical.
const providerSchema = z.enum([
  "STRIPE",
  "PAYPAL",
  "POLAR",
  "FREEMIUS",
  "GUMROAD",
])

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

// BIL-028: the admin checkout-attempts list — paginated, filterable
// by provider / user / status. Same pagination shape as the
// billing-events list.
const checkoutAttemptStatusSchema = z.enum(["CREATED", "COMPLETED", "FAILED"])

export const CheckoutAttemptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  provider: providerSchema.optional(),
  userId: z.string().trim().min(1).max(50).optional(),
  status: checkoutAttemptStatusSchema.optional(),
})

export type CheckoutAttemptsQuery = z.infer<typeof CheckoutAttemptsQuerySchema>

// BIL-016 / BIL-052: the customer/admin reconciliation body —
// which provider checkout to verify and activate. The id is the
// provider's checkout id (Stripe session id, PayPal subscription
// or order id), never a SendCMS id.
export const reconcileCheckoutSchema = z.object({
  provider: providerSchema,
  providerCheckoutId: z
    .string()
    .trim()
    .min(1, "providerCheckoutId is required")
    .max(200),
})

export type ReconcileCheckoutInput = z.infer<typeof reconcileCheckoutSchema>

// Payments list (Seven Admin Pages, Phase B, plan §3.5) — the money
// view. `tab` is the list's own status split (All / Succeeded /
// Failed / Refunded); `q` searches the customer by email, name, or
// user id. Same pagination shape as the billing-events list.
const paymentTabSchema = z.enum(["all", "succeeded", "failed", "refunded"])

export const PaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  provider: providerSchema.optional(),
  userId: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  tab: paymentTabSchema.default("all"),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type PaymentsQuery = z.infer<typeof PaymentsQuerySchema>

// Admin refund body (Seven Admin Pages, Phase B, plan §3.5, Q11).
// A full refund cancels the matching subscription (and flips a
// linked one-time purchase to REFUNDED); a partial refund keeps the
// subscription and needs the refunded amount in minor units. The
// refund itself must already have been issued at the provider —
// this records its SendCMS-side effects (see refundPayment).
export const RefundPaymentSchema = z
  .object({
    fullRefund: z.boolean().default(true),
    amountMinor: z.number().int().positive().nullable().optional(),
    reason: requiredString("A reason is required")
      .trim()
      .min(1, "A reason is required"),
  })
  .superRefine((data, ctx) => {
    if (
      !data.fullRefund &&
      (data.amountMinor === null || data.amountMinor === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "amountMinor is required for a partial refund",
        path: ["amountMinor"],
      })
    }
  })

export type RefundPaymentInput = z.infer<typeof RefundPaymentSchema>
