import { z } from "zod"

// Platform discount codes (Seven Admin Pages, Phase D, plan §3.7,
// Q6/Q7/Q10). Zod schemas for every request body and list query.
// Shared by the api routes and the admin UI's hooks. Query params
// arrive as strings, so page/perPage coerce and clamp here.
//
// Local string enums, NOT `z.nativeEnum` on the Prisma enums:
// importing the Prisma client runtime into validators would pull it
// into the client bundle (SRC-230). The drift-guard test in
// tests/seven-pages-phase-d-worker-a.test.ts asserts these lists
// and the Prisma enums stay identical.

export const CouponDiscountTypeSchema = z.enum(["PERCENT", "FIXED"])

export const CouponStatusSchema = z.enum(["ACTIVE", "DISABLED", "EXPIRED"])

export const BillingIntervalSchema = z.enum([
  "MONTHLY",
  "ANNUAL",
  "CUSTOM",
  "ONE_TIME",
])

// A coupon code is normalised upper-case with no spaces — the
// service applies the same normalisation defensively, so a code
// that reaches the service unparsed is still stored normalised.
export const CouponCodeSchema = z
  .string()
  .trim()
  .min(3, "Coupon code must be at least 3 characters.")
  .max(50, "Coupon code must be at most 50 characters.")
  .refine((code) => !/\s/.test(code), "Coupon code must not contain spaces.")
  .transform((code) => code.toUpperCase())

// Q6: PERCENT is 1–100; FIXED is a positive minor-units amount.
// validUntil must be after validFrom when both are set.
export const CreateCouponSchema = z
  .object({
    code: CouponCodeSchema,
    name: z.string().trim().max(100).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    discountType: CouponDiscountTypeSchema,
    discountValue: z.number().int(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code.")
      .default("USD"),
    maxRedemptions: z.number().int().min(1).optional().nullable(),
    maxRedemptionsPerUser: z.number().int().min(1).optional().nullable(),
    validFrom: z.coerce.date().optional().nullable(),
    validUntil: z.coerce.date().optional().nullable(),
    appliesToPlanIds: z.array(z.string().trim().min(1)).default([]),
    appliesToBillingInterval: BillingIntervalSchema.optional().nullable(),
    firstPurchaseOnly: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.discountType === "PERCENT") {
      if (input.discountValue < 1 || input.discountValue > 100) {
        ctx.addIssue({
          code: "custom",
          path: ["discountValue"],
          message: "A percent discount must be between 1 and 100.",
        })
      }
    } else if (input.discountValue < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "A fixed discount must be a positive amount in minor units.",
      })
    }
    if (
      input.validFrom &&
      input.validUntil &&
      input.validUntil <= input.validFrom
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be after validFrom.",
      })
    }
  })

// The service takes the INPUT shape (callers may omit the
// defaulted fields — currency, appliesToPlanIds,
// firstPurchaseOnly); it parses with the schema, which applies the
// defaults. The route passes parsed output, which is assignable to
// the input type. `CreateCouponParsed` is the post-parse shape.
export type CreateCouponInput = z.input<typeof CreateCouponSchema>
export type CreateCouponParsed = z.infer<typeof CreateCouponSchema>

// PATCH: mutable fields only — never code / discountType /
// discountValue / currency. The deal itself is immutable once
// issued: changing it would rewrite history for redemptions
// already recorded. status may move ACTIVE ↔ DISABLED; EXPIRED
// is derived (validUntil / cap) and cannot be set. At least one
// field is required; unknown keys (code, discountType,
// discountValue, currency) are rejected by .strict().
export const UpdateCouponSchema = z
  .object({
    name: z.string().trim().max(100).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    maxRedemptions: z.number().int().min(1).optional().nullable(),
    maxRedemptionsPerUser: z.number().int().min(1).optional().nullable(),
    validFrom: z.coerce.date().optional().nullable(),
    validUntil: z.coerce.date().optional().nullable(),
    appliesToPlanIds: z.array(z.string().trim().min(1)).optional(),
    appliesToBillingInterval: BillingIntervalSchema.optional().nullable(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Object.values(input).every((v) => v === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field must be provided.",
      })
    }
    if (
      input.validFrom &&
      input.validUntil &&
      input.validUntil <= input.validFrom
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must be after validFrom.",
      })
    }
  })

export type UpdateCouponInput = z.input<typeof UpdateCouponSchema>
export type UpdateCouponParsed = z.infer<typeof UpdateCouponSchema>

export const CouponsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["all", "ACTIVE", "DISABLED", "EXPIRED"]).default("all"),
  search: z.string().trim().max(100).optional(),
})

export type CouponsQuery = z.infer<typeof CouponsQuerySchema>

export const CouponRedemptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

export type CouponRedemptionsQuery = z.infer<
  typeof CouponRedemptionsQuerySchema
>
