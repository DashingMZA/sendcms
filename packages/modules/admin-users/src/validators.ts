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

// Admin user management (Phase 3) — Zod schemas for every request body
// and list query. Shared by the api routes and the admin UI's hooks.
// Query params arrive as strings, so page/perPage coerce and clamp here
// and emailVerified ("true"/"false") becomes a real boolean.

// Shared pagination for admin list endpoints.
export const AdminPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

export const AdminUserListQuerySchema = AdminPaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
  // "NONE" filters to users with no staff role (adminRole IS NULL).
  adminRole: z.enum(["SUPER_ADMIN", "MANAGER", "SUPPORT", "NONE"]).optional(),
  // Query params arrive as "true"/"false" strings; the transform runs
  // BEFORE .optional() so the inferred property stays optional.
  emailVerified: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z
    .enum([
      "createdAt:desc",
      "createdAt:asc",
      "name:asc",
      "name:desc",
      "email:asc",
      "email:desc",
    ])
    .optional()
    .default("createdAt:desc"),
})

export const AdminUserSubmissionsQuerySchema = AdminPaginationQuerySchema

export const AdminNotesQuerySchema = AdminPaginationQuerySchema

// Suspend / disable require a reason (non-empty, max 500 chars) — the
// reason is stored on the user and in the audit log.
export const SuspendUserSchema = z.object({
  reason: requiredString("Reason is required")
    .trim()
    .min(1, "Reason is required")
    .max(500),
})

export const DisableUserSchema = SuspendUserSchema

// Reactivate / restore take an optional reason.
export const ReactivateUserSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export const RestoreUserSchema = ReactivateUserSchema

// null removes the staff role (plain customer again).
export const SetAdminRoleSchema = z.object({
  adminRole: z.enum(["SUPER_ADMIN", "MANAGER", "SUPPORT"]).nullable(),
})

export const AddAdminNoteSchema = z.object({
  body: z.string().trim().min(1, "Note is required").max(2000),
})

export const RequestDeletionSchema = z.object({
  reason: requiredString("Reason is required")
    .trim()
    .min(1, "Reason is required")
    .max(500),
})

// SRC-104: step-up verification used to validate by hand in the
// route (`typeof body.password === "string"`, no length cap) — an
// unbounded string went straight to password-hash comparison. The
// cap is 128, the auth convention (users validators: minPasswordLength
// 8, maxPasswordLength 128) — a step-up password is a login password,
// so the same bound applies. A missing password fails with the human
// message, not Zod's invalid_type text.
export const StepUpVerifySchema = z.object({
  password: requiredString("Password is required")
    .min(1, "Password is required")
    .max(128, "Password is too long."),
})

export type StepUpVerifyInput = z.infer<typeof StepUpVerifySchema>

export type AdminPaginationQuery = z.infer<typeof AdminPaginationQuerySchema>
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>
export type AdminUserSubmissionsQuery = z.infer<
  typeof AdminUserSubmissionsQuerySchema
>
export type AdminNotesQuery = z.infer<typeof AdminNotesQuerySchema>
export type SuspendUserInput = z.infer<typeof SuspendUserSchema>
export type DisableUserInput = z.infer<typeof DisableUserSchema>
export type ReactivateUserInput = z.infer<typeof ReactivateUserSchema>
export type RestoreUserInput = z.infer<typeof RestoreUserSchema>
export type SetAdminRoleInput = z.infer<typeof SetAdminRoleSchema>
export type AddAdminNoteInput = z.infer<typeof AddAdminNoteSchema>
export type RequestDeletionInput = z.infer<typeof RequestDeletionSchema>
