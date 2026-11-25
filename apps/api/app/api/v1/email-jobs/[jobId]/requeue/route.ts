import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { requeueEmailJob } from "@sendcms/notifications"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ jobId: string }> }

// Requeues a FAILED or stuck-SENDING email job (Phase 16, EML-094/095).
// Owner-scoped in the service: a job that is not the caller's 404s,
// a job that is not FAILED or stuck past the lease 409s.
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { jobId } = await params
    const job = await requeueEmailJob(session.user.id, jobId)
    return ok({ id: job.id, status: job.status })
  } catch (err) {
    return handleApiError(err)
  }
}
