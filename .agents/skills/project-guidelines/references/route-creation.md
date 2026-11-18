# Route Creation

## Route Handler Template

```ts
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { ok, created, noContent } from "@/lib/api/response"
import { ApiError, handleApiError } from "@/lib/api/error"
import { someService } from "@/lib/services/some-service"
import { SomeSchema } from "@/lib/validators/some"

export async function GET(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
    const { siteId } = await params
    const data = await someService.doSomething(siteId)
    return ok(data)
  } catch (err) {
    return handleApiError(err)
  }
}
```

## Patterns

| Type | Path | Auth | Notes |
|---|---|---|---|
| Admin API | `app/api/v1/<resource>/route.ts` | Session cookie | No CORS needed |
| Public API | `app/api/public/v1/submit/route.ts` | None — Origin allowlist | Export `OPTIONS` + CORS echo for allowed origins only |
| Dashboard page | `app/dashboard/<section>/page.tsx` | Server component | Fetch data, pass to client |
| Detail page | `app/dashboard/forms/[formId]/page.tsx` | Server component | Owner-scoped fetch, 404 → `notFound()` |
| Service | `lib/services/<name>-service.ts` | N/A | No Next.js imports |
| Validator | `lib/validators/<name>.ts` | N/A | Zod schema, shared |
| Hook | `hooks/use-<name>.ts` | N/A | Client-side only |

## Public API Route Pattern

```ts
import { getEffectiveOrigin } from "@/lib/cors"
import { submitForm } from "@/lib/services/submission-service"

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: publicCorsHeaders(getEffectiveOrigin(req) ?? "*") })
}

export async function POST(req: NextRequest) {
  try {
    // ... content-length check, Zod parse, submitForm(body, meta) ...
    // Success: 201 created / 200 duplicate, CORS headers echoed.
    // Errors: ApiError carries originAllowed — handleApiError only echoes
    // CORS headers when the origin passed the allowlist.
  } catch (err) {
    return handleApiError(err)
  }
}
```

## Validation Pattern

```ts
import { SomeSchema } from "@/lib/validators/some"

const parsed = SomeSchema.safeParse(body)
if (!parsed.success) {
  const flat = parsed.error.flatten()
  const messages = [...flat.formErrors, ...Object.values(flat.fieldErrors).flat()].filter(Boolean)
  return NextResponse.json({ error: messages.join("; ") || "Validation failed" }, { status: 422 })
}
```

## Cache Revalidation

After writes that affect dashboard UI:

```ts
import { revalidatePath } from "next/cache"
revalidatePath("/dashboard", "layout")
```

## Adding a New Feature (Checklist)

- [ ] Model (if needed) with `id`, `createdAt`, `updatedAt`
- [ ] Indexes on all FKs and common query fields
- [ ] Enums for status/role fields
- [ ] Service in `lib/services/` (no Next.js imports)
- [ ] Validator in `lib/validators/` (Zod)
- [ ] Route handler (thin, try/catch + handleApiError)
- [ ] Public API route: OPTIONS + CORS echo only for allowed origins; durable save before the success response; idempotency key honored
- [ ] `pnpm typecheck` passes
- [ ] Migration with descriptive name (if schema changed)
