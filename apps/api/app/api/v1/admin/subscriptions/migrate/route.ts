import { NextRequest, NextResponse } from "next/server"
import { requireAdminApi } from "@/lib/require-admin-api"
import { enforceAdminApiRateLimit } from "@/lib/rate-limit"
import { executeMigration } from "@sendcms/plans"
import { ExecuteMigrationSchema } from "@sendcms/plans/validators"
import { handleApiError, ok } from "@sendcms/api-client"

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminApi("MIGRATE_SUBSCRIPTIONS")
    const rateLimited = await enforceAdminApiRateLimit(req, session.user.id)
    if (rateLimited) return rateLimited
    const body = await req.json().catch(() => ({}))
    const parsed = ExecuteMigrationSchema.safeParse(body)
    if (!parsed.success) {
      const flat = parsed.error.flatten()
      const messages = [
        ...flat.formErrors,
        ...Object.values(flat.fieldErrors).flat(),
      ].filter(Boolean)
      return NextResponse.json(
        { error: messages.join("; ") || "Validation failed" },
        { status: 422 }
      )
    }
    const result = await executeMigration(session, parsed.data)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
