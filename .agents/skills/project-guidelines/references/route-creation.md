# Route Creation

## Route Handler Template

```ts
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  ApiError,
  created,
  handleApiError,
  noContent,
  ok,
} from "@sendcms/api-client"
import { someService } from "@sendcms/<module>"
import { SomeSchema } from "@sendcms/<module>/validators"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
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

| Type           | Path                                                   | Auth                    | Notes                                                                                            |
| -------------- | ------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------ |
| Admin API      | `apps/api/app/api/v1/<resource>/route.ts`              | Session cookie          | No CORS needed                                                                                   |
| Public API     | `apps/api/app/api/public/v1/submit/route.ts`           | None — Origin allowlist | Export `OPTIONS` + CORS echo for allowed origins only                                            |
| Dashboard page | `apps/dashboard/app/dashboard/<section>/page.tsx`      | Server component        | Fetch data, pass to client                                                                       |
| Detail page    | `apps/dashboard/app/dashboard/forms/[formId]/page.tsx` | Server component        | Owner-scoped fetch, 404 → `notFound()`                                                           |
| Marketing page | `apps/marketing/app/<page>/page.tsx`                   | Server component        | Public, no auth — links to sibling apps must be absolute (see `apps/marketing/lib/app-links.ts`) |
| Docs page      | `apps/docs/app/docs/[slug]/page.tsx`                   | Server component        | Renders a user doc from the repo's `docs/` dir; unknown slugs 404                                |
| Updates page   | `apps/updates/app/changelog/page.tsx`                  | Server component        | Public, no auth — home links point at the marketing app                                          |
| Service        | `packages/modules/<name>/src/service.ts`               | N/A                     | No Next.js imports                                                                               |
| Validator      | `packages/modules/<name>/src/validators.ts`            | N/A                     | Zod schema, shared                                                                               |
| Hook           | `packages/ui/src/hooks/use-<name>.ts`                  | N/A                     | Client-side only (shared hooks live in the ui package)                                           |

## Public API Route Pattern

```ts
import { getEffectiveOrigin } from "@sendcms/api-client"
import { submitForm } from "@sendcms/submissions"

// Route-local CORS headers for the public submit API (POST/OPTIONS).
// The admin routes use corsHeaders() from @sendcms/api-client; the
// public route defines its own because its method/header set differs.
function publicCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

export async function OPTIONS(req: NextRequest) {
  return new Response(null, {
    status: 204,
    headers: publicCorsHeaders(getEffectiveOrigin(req) ?? "*"),
  })
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
import { SomeSchema } from "@sendcms/<module>/validators"

const parsed = SomeSchema.safeParse(body)
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
- [ ] Service in `packages/modules/<name>/src/service.ts` (no Next.js imports)
- [ ] Validator in `packages/modules/<name>/src/validators.ts` (Zod)
- [ ] Route handler (thin, try/catch + handleApiError)
- [ ] Public API route: OPTIONS + CORS echo only for allowed origins; durable save before the success response; idempotency key honored
- [ ] `pnpm typecheck` passes
- [ ] Migration with descriptive name (if schema changed)
