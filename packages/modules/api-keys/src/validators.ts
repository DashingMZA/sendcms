import { z } from "zod"

export const ApiKeyScopeSchema = z.enum(["READ", "FULL"])

export const CreateApiKeySchema = z.object({
  name: z.string().min(1, "Name the key").max(100),
  // SRC-229: least privilege by default — an omitted scope used to
  // create a FULL key. Callers that need mutations pass "FULL"
  // explicitly (the dashboard select defaults to READ too).
  scope: ApiKeyScopeSchema.default("READ"),
})

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>
