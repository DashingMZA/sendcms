# Coding Conventions

## Style

| Rule                | Pattern                                              |
| ------------------- | ---------------------------------------------------- |
| Indentation         | 2 spaces, no tabs                                    |
| Quotes              | Single quotes. Double only when string contains `'`. |
| Semicolons          | Always                                               |
| Variables/functions | camelCase (`getUserData`)                            |
| Components          | PascalCase (`UserProfile`)                           |
| Constants           | UPPER_SNAKE_CASE (`API_URL`)                         |
| Functional          | Prefer `map`/`filter`/`reduce`. No mutation.         |

## Architecture: Layered Request Flow

```
apps/api/app/api/**  →  route handler (thin: parse, auth, call service, respond)
packages/modules/<name>/src/service.ts →  business logic (NO Next.js imports)
@sendcms/database   →  Prisma singleton `db` (only services import this)
packages/modules/<name>/src/validators.ts →  Zod schemas (shared by routes + services)
@sendcms/api-client →  response.ts (ok, created, noContent) + error.ts (handleApiError; ApiError lives in @sendcms/shared, re-exported) + cors.ts (getEffectiveOrigin, normalizeOrigin, corsHeaders)
@sendcms/email      →  platform email: provider + auth mailer + notification deps (imported directly by the auth factory and the notifications module — no injection since Phase 9)
@sendcms/queue      →  email outbox queue: EmailJob claim + retry state machine (imported by the notifications module)
@sendcms/security   →  shared security headers (`securityHeaders()` / `renderHeadersFile()`) + the one `logAudit()` writer (imported by services; the audit writer, the rate limiter, and step-up re-auth are documented exceptions to "only services import @sendcms/database" — like @sendcms/auth is for auth; the full exception list lives in `tests/architecture-db-imports.test.ts`, which fails CI on any unlisted importer)
@sendcms/observability →  structured logging: `createLogger(scope)` writes JSON lines (imported by server code that used to console.log/console.error)
```

Route handlers must NOT import `@sendcms/database` directly. Services must NOT import from `next/*`.

The `db` value may be imported only from module services
(`packages/modules/*/src/**`, never their `queries.ts` / `validators.ts`)
and from the documented infrastructure exceptions — `@sendcms/auth` (the
auth factory), `@sendcms/security` (the audit writer, the rate limiter,
step-up re-auth), `@sendcms/mcp` (`access` / `rate-limit` / `usage`),
`@sendcms/queue` (the email-outbox claim/retry state machine), the
`@sendcms/permissions/target-user` subpath only (`getTargetUserOrThrow`;
the permissions root stays dependency-free so proxies and client
components can import `platformCan` / `adminCan` without pulling the
Prisma client into an edge or browser bundle), and the api app's
Node-only boot check (`apps/api/instrumentation-node.ts` — the Turnstile
startup check; not a route handler, never Edge/client code). These
packages are single-purpose infrastructure, like the rate limiter —
routing their DB access through a service layer would be a fake
abstraction.
`tests/architecture-db-imports.test.ts` asserts the exact importer set,
so a new direct `db` import fails CI until it is added to the list
here with a reason.

Server code logs through `createLogger(scope)` from `@sendcms/observability`, not `console` — except the auth mailer's dev verification-link line (its exact `[auth-email]` format is greppable and the journey depends on it) and the seed script (a CLI script).

## Server Components vs Client Components

| Aspect        | Server Component                   | Client Component                                     |
| ------------- | ---------------------------------- | ---------------------------------------------------- |
| Directive     | None (default)                     | `"use client"` at top                                |
| Data fetching | Direct service calls               | `@sendcms/<module>/queries` hooks (React Query)      |
| Mutations     | Not allowed                        | `useMutation` hooks from `@sendcms/<module>/queries` |
| Usage         | Page shells, layouts, data loaders | Forms, tables, interactive UI                        |
| State         | No useState/useEffect              | Full React hooks                                     |

**Pattern:** Server component fetches data via the service layer → passes it as `initialData` into a client component's React Query hook. The hook owns refetch/cache/mutation from there.

```tsx
// Server component (page.tsx)
export default async function InboxPage({ searchParams }: PageProps) {
  const session = await auth()
  const filters = InboxListQuerySchema.parse(await searchParams)
  const inbox = await listSubmissionsForUser(session.user.id, filters)
  return <InboxTable initialData={inbox} filters={filters} />
}

// Client component (inbox-table.tsx)
;("use client")
export function InboxTable({ initialData, filters }: Props) {
  const { data: inbox } = useInbox(filters, initialData)
  const updateStatus = useUpdateSubmissionStatus()
  // interactive UI, mutations via React Query
}
```

## Client Data Fetching (React Query)

All client-side reads and writes go through `@tanstack/react-query`, never raw `fetch()` in a component.

```
@sendcms/shared (api-client.ts) →  apiFetch<T>(path, init) — typed wrapper, throws ApiClientError({ message, status, details })
@sendcms/<module>/queries →  one file per module (domains, forms, inbox, notifications)
                         exports a query-key factory + useXQuery / useXMutation hooks
```

- Components call hooks from `@sendcms/<module>/queries`. They never call `apiFetch` or `fetch` directly.
- `QueryClientProvider` is mounted once in `apps/dashboard/app/dashboard/layout.tsx` (dashboard-only — public pages don't need it).
- Errors surface via a **global default**: the `QueryClient`'s `queryCache`/`mutationCache` `onError` shows a sonner toast automatically. Pass `meta: { silent: true }` on a query/mutation only when the call site needs custom error UX instead.
- Initial render uses `initialData` from the server-fetched props (no `dehydrate`/`HydrationBoundary` — one query per page, not nested trees).

```ts
// packages/modules/domains/src/queries.ts
export const domainKeys = { detail: (id: string) => ["domains", id] as const }

export function useDomain(id: string, initialData?: DomainDetail) {
  return useQuery({
    queryKey: domainKeys.detail(id),
    queryFn: () => apiFetch<DomainDetail>(`/api/v1/domains/${id}`),
    initialData,
  })
}

export function useUpdateDomain(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<DomainDetail>) =>
      apiFetch<DomainDetail>(`/api/v1/domains/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onMutate: async (body) => {
      const previous = qc.getQueryData<DomainDetail>(domainKeys.detail(id))
      qc.setQueryData(domainKeys.detail(id), (old: DomainDetail) => ({
        ...old,
        ...body,
      }))
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(domainKeys.detail(id), ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: domainKeys.detail(id) }),
  })
}
```

List-shaped optimistic updates (inbox table, forms table) follow the same `onMutate`/`onError` snapshot-and-rollback shape over the list's query key.

## Forms

No react-hook-form. No form library. Native HTML forms + a `@sendcms/<module>/queries` mutation hook:

```tsx
"use client"
export function FormSettingsForm({ form }: Props) {
  const updateForm = useUpdateForm(form.id)
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    updateForm.mutate({ name: data.get("name") as string })
  }
  return <form onSubmit={handleSubmit}>...</form>
}
```

## Optimistic Updates

Use `useMutation`'s `onMutate`/`onError`/`onSettled` against the React Query cache — do not use `hooks/use-optimistic-state.ts` (removed) or React's built-in `useOptimistic`. See "Client Data Fetching (React Query)" above for the full pattern.

## URL-as-State

Search/filter/pagination uses URL params. Client pushes URLs, server reads `searchParams`:

```tsx
// Client: search input pushes URL
router.push(`?search=${query}`)

// Server: page reads searchParams
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>
}) {
  const { search } = await searchParams
}
```

## Error Handling

| Layer                    | Pattern                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Route handlers           | `try { ... } catch (err) { return handleApiError(err) }`                                                       |
| Services                 | `throw new ApiError("message", statusCode)`                                                                    |
| Client fetcher           | `@sendcms/shared` `apiFetch` throws `ApiClientError(message, status, details)`                                 |
| Client queries/mutations | `QueryClient`'s default `onError` → `toast.error()` via sonner. Override per-call only when UX needs to differ |
| Error boundaries         | `error.tsx` files at route levels                                                                              |

**ApiError codes used:** 400 (bad input), 401 (unauthorized), 403 (forbidden), 404 (not found), 409 (conflict), 429 (rate limit).

## Cache Revalidation

Routes do NOT call `revalidatePath()` (SRC-114). The refresh mechanism
after a mutation is React Query invalidation: every mutation hook
invalidates its queries `onSuccess`/`onSettled` (see "Client Data
Fetching (React Query)" above), so the dashboard and admin UIs refetch
from the API and never show stale data. The 17 older route files that
still call `revalidatePath` after writes are harmless leftovers from
the Phase 3–5 era — they may stay, but no new route needs them.

## Permissions (RBAC)

Single source of truth in `packages/permissions/`:

| File                                   | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/permissions/src/platform.ts` | `PlatformRole`, `PlatformCapability`, `platformCan()`, `PLATFORM_ROUTE_CAPABILITY` |
| `packages/permissions/src/index.ts`    | Barrel re-export                                                                   |

**Platform capabilities:** `VIEW_NOTICE_BOARD`, `VIEW_ADMINISTRATION`, `MANAGE_PLATFORM_SETTINGS` (only `PLATFORM_OWNER` has any)

**Import from:** `@sendcms/permissions` (barrel), never deep paths.

## Key Conventions

| Concept       | Rule                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DRY           | If logic used in 2+ places → extract to `lib/` or `lib/utils.ts`                                                                                                                                             |
| Config        | Feature flags in `config/config.json`. Not `.env`.                                                                                                                                                           |
| Code Comments | Always write clear and concise comments but not bloated to explain the purpose of complex code blocks, functions, or components and Clear variable and function names can often reduce the need for comments |
| Parallelism   | Use `Promise.all` for independent queries in services                                                                                                                                                        |
| Transactions  | Array form for independent batch writes, callback form for dependent sequential writes                                                                                                                       |
