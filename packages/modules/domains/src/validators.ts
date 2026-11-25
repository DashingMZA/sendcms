import { z } from "zod"

export const DomainMethodSchema = z.enum(["DNS_TXT", "META_TAG", "FILE"])

export const CreateDomainSchema = z.object({
  domain: z.string().min(1, "Enter a domain").max(253),
  method: DomainMethodSchema.optional().default("DNS_TXT"),
})

export type CreateDomainInput = z.infer<typeof CreateDomainSchema>

export const DomainActionSchema = z.object({
  action: z.enum(["suspend", "reactivate"]),
})

export type DomainActionInput = z.infer<typeof DomainActionSchema>

export const ReverifyDomainSchema = z.object({
  method: DomainMethodSchema.optional(),
})

export type ReverifyDomainInput = z.infer<typeof ReverifyDomainSchema>

// DSH-107: the domains list query. `limit` is an alias for
// `perPage` (the public probes used `?limit=1&page=2`); when both
// are given, `limit` wins. Unknown pagination params are rejected
// by the route's safeParse instead of silently dropped (strict).
export const DomainListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.enum(["createdAt", "name"]).default("createdAt"),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .transform((v) => ({
    search: v.search,
    page: v.page,
    perPage: v.limit ?? v.perPage,
    sortBy: v.sortBy,
    sortDir: v.sortDir,
  }))

export type DomainListQueryInput = z.infer<typeof DomainListQuerySchema>
