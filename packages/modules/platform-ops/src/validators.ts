// Platform operations (Admin Control Plane, Phase 7) — Zod schemas
// for every request body and list query. Shared by the api routes and
// the admin UI's hooks. Query params arrive as strings, so page/perPage
// coerce and clamp here.
//
// Audit filter values (action / resourceType / outcome) are NOT
// validated here: they are Prisma enums and the service checks
// membership against the live enum values, so a bad value is a 422
// from the service, not a second copy of the enum list in this file.
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

// Shared pagination for admin list endpoints (max 100 per page).
export const PlatformOpsPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── Feature flags ────────────────────────────────────────────────────

// A flag key is the stable machine name (e.g. "ai-features"): lowercase
// letters, digits and hyphens, never starting with a hyphen.
export const FlagKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens.")

export const CreateFlagSchema = z.object({
  key: FlagKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
})

export type CreateFlagInput = z.infer<typeof CreateFlagSchema>

// `reason` is required — toggling a flag for the whole platform is a
// sensitive action and the audit record must say why.
export const SetFlagSchema = z.object({
  isEnabled: z.boolean(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type SetFlagInput = z.infer<typeof SetFlagSchema>

// A per-user override is an admin decision about one customer, so the
// reason is required here too.
export const SetFlagOverrideSchema = z.object({
  isEnabled: z.boolean(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type SetFlagOverrideInput = z.infer<typeof SetFlagOverrideSchema>

// The override POST body carries the target user too (the route
// extracts userId and passes the rest as the override input).
export const SetFlagOverrideBodySchema = SetFlagOverrideSchema.extend({
  userId: z.string().trim().min(1),
})

export type SetFlagOverrideBodyInput = z.infer<typeof SetFlagOverrideBodySchema>

// ─── Announcements ────────────────────────────────────────────────────

const announcementWindow = z
  .object({
    startsAt: z.string().trim().min(1).optional(),
    endsAt: z.string().trim().min(1).optional(),
  })
  .refine(
    (v) => {
      if (!v.startsAt || !v.endsAt) return true
      const start = new Date(v.startsAt)
      const end = new Date(v.endsAt)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
        return true
      return end > start
    },
    { message: "endsAt must be after startsAt." }
  )

export const CreateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2000),
    audience: z.enum(["ALL", "ADMIN_ONLY"]).default("ALL"),
    startsAt: z.string().trim().min(1).optional(),
    endsAt: z.string().trim().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const check = announcementWindow.safeParse({
      startsAt: v.startsAt,
      endsAt: v.endsAt,
    })
    if (!check.success) {
      for (const issue of check.error.issues) {
        ctx.addIssue({ ...issue, path: ["endsAt"] })
      }
    }
  })

export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>

// Partial update — only the fields present change. A null startsAt /
// endsAt clears the window bound.
export const UpdateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(2000).optional(),
    audience: z.enum(["ALL", "ADMIN_ONLY"]).optional(),
    startsAt: z.string().trim().min(1).nullable().optional(),
    endsAt: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const check = announcementWindow.safeParse({
      startsAt: v.startsAt ?? undefined,
      endsAt: v.endsAt ?? undefined,
    })
    if (!check.success) {
      for (const issue of check.error.issues) {
        ctx.addIssue({ ...issue, path: ["endsAt"] })
      }
    }
  })

export type UpdateAnnouncementInput = z.infer<typeof UpdateAnnouncementSchema>

export const SetAnnouncementActiveSchema = z.object({
  isActive: z.boolean(),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type SetAnnouncementActiveInput = z.infer<
  typeof SetAnnouncementActiveSchema
>

// The detail PATCH accepts field updates AND the active toggle in one
// endpoint: when `isActive` is present the toggle wins (reason
// required); otherwise the field update runs.
export const UpdateAnnouncementBodySchema = UpdateAnnouncementSchema.extend({
  isActive: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
})

export type UpdateAnnouncementBodyInput = z.infer<
  typeof UpdateAnnouncementBodySchema
>

export const AnnouncementsQuerySchema = PlatformOpsPaginationQuerySchema.extend(
  {
    isActive: z
      .string()
      .transform((v) => v === "true")
      .optional(),
    audience: z.enum(["ALL", "ADMIN_ONLY"]).optional(),
  }
)

export type AnnouncementsQuery = z.infer<typeof AnnouncementsQuerySchema>

// ─── Audit trail ──────────────────────────────────────────────────────

export const AuditLogsQuerySchema = PlatformOpsPaginationQuerySchema.extend({
  actorId: z.string().trim().min(1).optional(),
  targetUserId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  resourceType: z.string().trim().min(1).optional(),
  outcome: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1).optional(),
  // ISO date strings, inclusive bounds.
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
})

export type AuditLogsQuery = z.infer<typeof AuditLogsQuerySchema>

// ─── Abuse / spam queue ───────────────────────────────────────────────

export const PlatformSubmissionsQuerySchema =
  PlatformOpsPaginationQuerySchema.extend({
    status: z.enum(["NEW", "READ", "STARRED", "ARCHIVED", "SPAM"]).optional(),
    formId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })

export type PlatformSubmissionsQuery = z.infer<
  typeof PlatformSubmissionsQuerySchema
>

// The admin sets the target status directly (NEW | SPAM | ARCHIVED).
// The service maps it onto the inbox's own transition rules, so a
// restore lands on READ — the inbox's rule, not a second rulebook.
export const UpdatePlatformSubmissionStatusSchema = z.object({
  status: z.enum(["NEW", "SPAM", "ARCHIVED"]),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type UpdatePlatformSubmissionStatusInput = z.infer<
  typeof UpdatePlatformSubmissionStatusSchema
>

// ─── Deletion workflow ────────────────────────────────────────────────

export const ReviewDeletionRequestSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type ReviewDeletionRequestInput = z.infer<
  typeof ReviewDeletionRequestSchema
>

export const ExecuteErasureSchema = z.object({
  reason: requiredString("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500),
})

export type ExecuteErasureInput = z.infer<typeof ExecuteErasureSchema>

export const DeletionRequestsQuerySchema =
  PlatformOpsPaginationQuerySchema.extend({
    status: z
      .enum(["REQUESTED", "APPROVED", "REJECTED", "COMPLETED"])
      .optional(),
  })

export type DeletionRequestsQuery = z.infer<typeof DeletionRequestsQuerySchema>

// ─── Admin overview ─────────────────────────────────────────────────

export const OVERVIEW_RANGES = [
  "24h",
  "7d",
  "30d",
  "90d",
  "12mo",
  "custom",
] as const

export type OverviewRangeKey = (typeof OVERVIEW_RANGES)[number]

// The overview date filter: a preset range, or a custom from/to pair.
// Query params arrive as strings, so from/to are validated as
// parseable dates here (a date input sends "YYYY-MM-DD") — not
// datetime-only.
export const OverviewQuerySchema = z
  .object({
    range: z.enum(OVERVIEW_RANGES).default("7d"),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.range !== "custom") return
    if (!v.from || !v.to) {
      ctx.addIssue({
        code: "custom",
        message: "Custom range needs from and to.",
        path: ["from"],
      })
      return
    }
    const from = new Date(v.from)
    const to = new Date(v.to)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "from and to must be valid dates.",
        path: ["from"],
      })
      return
    }
    if (to <= from) {
      ctx.addIssue({
        code: "custom",
        message: "to must be after from.",
        path: ["to"],
      })
      return
    }
    if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: "custom",
        message: "Custom range is at most 366 days.",
        path: ["to"],
      })
    }
  })

export type OverviewQuery = z.infer<typeof OverviewQuerySchema>
