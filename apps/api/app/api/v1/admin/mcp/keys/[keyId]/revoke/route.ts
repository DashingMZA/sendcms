import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { revokeMcpKey } from "@sendcms/mcp-admin"
import { RevokeMcpKeySchema } from "@sendcms/mcp-admin/validators"
import { ApiError, handleApiError, ok } from "@sendcms/api-client"

type Params = { params: Promise<{ keyId: string }> }

// Revokes one API key. The key stops working immediately; the
// revocation is audited with the reason.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { keyId } = await params
    const body = await req.json().catch(() => ({}))
    const parsed = RevokeMcpKeySchema.safeParse(body)
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
    const result = await revokeMcpKey(session, keyId, parsed.data.reason)
    return ok(result)
  } catch (err) {
    return handleApiError(err)
  }
}
