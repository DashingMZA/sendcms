import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { getPlan } from "@sendcms/plans"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { planId } = await params
    const plan = await getPlan(session, planId)
    return ok(plan)
  } catch (err) {
    return handleApiError(err)
  }
}
