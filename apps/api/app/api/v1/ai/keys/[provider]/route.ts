import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { deleteUserAiKey, getUserAiKey } from "@sendcms/ai-settings"
import { AiProviderNameSchema } from "@sendcms/ai-settings/validators"
import { ApiError, handleApiError, noContent, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ provider: string }> }

function parseProvider(params: { provider: string }) {
  const parsed = AiProviderNameSchema.safeParse(params.provider)
  if (!parsed.success) throw new ApiError("Unknown provider.", 422)
  return parsed.data
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const provider = parseProvider(await params)
    const key = await getUserAiKey(session.user.id, provider)
    return ok({ key })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const provider = parseProvider(await params)
    await deleteUserAiKey(session.user.id, provider)
    return noContent()
  } catch (err) {
    return handleApiError(err)
  }
}
