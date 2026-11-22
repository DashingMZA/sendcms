// Support ticket system (Admin Control Plane, Phase 8) — Zod schemas
// for every request body and list query. Shared by the api routes and
// the UI hooks. Query params arrive as strings, so page/perPage coerce
// and clamp here.
//
// The status machine itself is NOT validated here: the service
// enforces the transition map (see service.ts) — the schema only
// checks the value is a real status.
import { z } from "zod"

// Shared pagination for list endpoints.
export const SupportPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
})

export const TicketPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"])

export const TicketStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_ON_CUSTOMER",
  "RESOLVED",
  "CLOSED",
])

// ─── Customer ───────────────────────────────────────────────────────────

export const CreateTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  priority: TicketPrioritySchema.default("NORMAL"),
})

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>

export const ReplyToTicketSchema = z.object({
  body: z.string().trim().min(1).max(2000),
})

export type ReplyToTicketInput = z.infer<typeof ReplyToTicketSchema>

export const MyTicketsQuerySchema = SupportPaginationQuerySchema.extend({
  status: TicketStatusSchema.optional(),
})

export type MyTicketsQuery = z.infer<typeof MyTicketsQuerySchema>

// ─── Admin ──────────────────────────────────────────────────────────────

export const AdminTicketsQuerySchema = SupportPaginationQuerySchema.extend({
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
  assignedToId: z.string().trim().min(1).optional(),
  // Free-text search over the subject (case-insensitive).
  search: z.string().trim().min(1).max(200).optional(),
})

export type AdminTicketsQuery = z.infer<typeof AdminTicketsQuerySchema>

// `reason` is required — changing a ticket's status is a sensitive
// action and the audit record must say why.
export const SetTicketStatusSchema = z.object({
  status: TicketStatusSchema,
  reason: z.string().trim().min(1).max(500),
})

export type SetTicketStatusInput = z.infer<typeof SetTicketStatusSchema>

// `reason` is required — assigning a ticket is a sensitive action and
// the audit record must say why.
export const AssignTicketSchema = z.object({
  assignedToId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
})

export type AssignTicketInput = z.infer<typeof AssignTicketSchema>
