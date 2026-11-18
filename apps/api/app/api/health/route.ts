import { pingDatabase } from "@sendcms/database"
import { handleApiError, ok } from "@sendcms/api-client"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const health = await pingDatabase()
    return ok(health)
  } catch (err) {
    return handleApiError(err)
  }
}
