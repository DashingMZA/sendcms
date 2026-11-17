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
