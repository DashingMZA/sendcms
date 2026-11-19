import { z } from "zod"

export const ApiKeyScopeSchema = z.enum(["READ", "FULL"])

export const CreateApiKeySchema = z.object({
  name: z.string().min(1, "Name the key").max(100),
  scope: ApiKeyScopeSchema.default("FULL"),
})

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>
