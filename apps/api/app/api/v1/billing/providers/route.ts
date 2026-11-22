import { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { listEnabledProviders } from "@sendcms/billing"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

// Providers the signed-in customer may check out with, for their
// country (?country=XX). Disabled, unconfigured, and
// country-restricted providers are hidden here.
export async function GET(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const country = req.nextUrl.searchParams.get("country")
    return ok(await listEnabledProviders(country))
  } catch (err) {
    return handleApiError(err)
  }
}
