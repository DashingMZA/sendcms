import { z } from "zod"
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
  reason: z.string().trim().min(1, "A reason is required"),
})

// POST /admin/billing/providers body: same as the PATCH, plus the
// provider id from the collection route.
export const setProviderConfigBodySchema = setProviderConfigSchema.extend({
  provider: providerSchema,
})

export const checkoutSessionSchema = z.object({
  planVersionId: z.string().trim().min(1, "planVersionId is required"),
  provider: providerSchema,
  // ISO alpha-2 country of the customer; the page sends the geo-detected
  // or customer-selected code. Optional — without it the country filter
  // is skipped.
  countryCode: isoCountryCode.optional(),
})

export type SetProviderConfigInput = z.infer<typeof setProviderConfigSchema>
export type SetProviderConfigBodyInput = z.infer<
  typeof setProviderConfigBodySchema
>
export type CheckoutSessionInput = z.infer<typeof checkoutSessionSchema>
