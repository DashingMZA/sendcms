import { ok } from "@/lib/api/response"
import { handleApiError } from "@/lib/api/error"
import { pingDatabase } from "@sendcms/database"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const health = await pingDatabase()
    return ok(health)
  } catch (err) {
    return handleApiError(err)
  }
}
