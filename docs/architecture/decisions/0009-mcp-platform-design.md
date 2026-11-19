# ADR 0009 — MCP platform design (design only, not built)

- Status: proposed (2026-11-19, Phase 11) — design only, **not implemented**
- Context: the audit's Phase 11 ("MCP foundation") and the owner's
  2026-11-18 decision to defer MCP/AI entirely. The owner asked for the
  design document now (2026-11-19) and will decide separately when — or
  whether — to build it. This record is the Phase 11 deliverable. **No
  code was written for it: no `packages/mcp`, no `apps/mcp`, no route,
  no dependency installed.**

## What MCP would be for SendCMS

The Model Context Protocol lets an AI host (Claude Desktop, an IDE, an
agent) call SendCMS as a _tool server_: the host's model lists a user's
domains and forms, reads inbox submissions, and acts on them — without
the user opening the dashboard. It is a second API surface over the same
business logic, not a second product.

## Decision 1 — Tool surface (mapped 1:1 to the module services)

Every tool maps to an existing `*ForUser` service function (ADR 0003).
No tool re-implements business logic, and no tool exists for a
capability the modules don't have.

| Tool                      | Service function                                   | Module                   |
| ------------------------- | -------------------------------------------------- | ------------------------ |
| `list_domains`            | `listDomainsForUser`                               | `@sendcms/domains`       |
| `get_domain`              | `getDomainForUser`                                 | `@sendcms/domains`       |
| `create_domain`           | `createDomainForUser`                              | `@sendcms/domains`       |
| `verify_domain`           | `startVerificationForUser` + `verifyDomainForUser` | `@sendcms/domains`       |
| `delete_domain`           | `deleteDomainForUser`                              | `@sendcms/domains`       |
| `list_forms`              | `listFormsForUser`                                 | `@sendcms/forms`         |
| `get_form`                | `getFormForUser`                                   | `@sendcms/forms`         |
| `create_form`             | `createFormForUser`                                | `@sendcms/forms`         |
| `update_form`             | `updateFormForUser`                                | `@sendcms/forms`         |
| `delete_form`             | `deleteFormForUser`                                | `@sendcms/forms`         |
| `list_submissions`        | `listSubmissionsForUser`                           | `@sendcms/inbox`         |
| `get_submission`          | `getSubmissionForUser`                             | `@sendcms/inbox`         |
| `update_submission`       | `updateSubmissionStatusForUser`                    | `@sendcms/inbox`         |
| `bulk_update_submissions` | `bulkUpdateSubmissionsForUser`                     | `@sendcms/inbox`         |
| `delete_submission`       | `deleteSubmissionForUser`                          | `@sendcms/inbox`         |
| `get_overview`            | `getDashboardOverview`                             | `@sendcms/analytics`     |
| `get_analytics`           | `getSubmissionAnalytics`                           | `@sendcms/analytics`     |
| `list_email_jobs`         | `listEmailJobsForUser`                             | `@sendcms/notifications` |
| `send_test_email`         | `sendTestSubmissionEmail`                          | `@sendcms/notifications` |

Read-only tools come first in the build order (list/get/overview), then
mutations. Tool input validation reuses the modules' existing Zod
validators (the `./validators` subpaths) — the same schemas the REST
routes already share with the services.

Explicitly **not** tools:

- Public submit (`submitForm` in `@sendcms/submissions`). Submissions
  arrive unauthenticated through the public REST API with its spam
  heuristics, honeypot, and DB-backed rate limits. An MCP tool must not
  become a second, privileged submission path that bypasses them.
- User management. The `@sendcms/users` module is reads-only
  (`lookupUserByEmail`, `getUserAuthMethods`); no user mutations exist
  to expose, and an MCP tool must never create, promote, or delete
  users.
- Cron / worker internals (`processEmailOutbox`, the email worker).
  Those are platform operations, not owner actions.
- Any platform-owner action (there is no such tool surface; the first
  user is PLATFORM_OWNER by a DB-level promotion, not by an API).

## Decision 2 — Transport: Streamable HTTP, one endpoint

The MCP specification's remote transport is **Streamable HTTP**
(introduced in spec `2025-03-26`; the older HTTP+SSE transport has been
deprecated since then, and the current `2026-07-28` revision made the
transport stateless — no protocol sessions, no standalone GET stream, no
stream resumability). A new server must not adopt HTTP+SSE, and must not
offer an SSE-only endpoint.

Concretely: one endpoint, `POST /api/mcp`, accepting
`Accept: application/json, text/event-stream`, answering each request
with a single JSON object or a per-response SSE stream. No `stdio`
transport — that is for local servers; SendCMS is a hosted SaaS, so its
MCP server is remote.

## Decision 3 — Hosting: a route in `apps/api`, not a separate app

The MCP endpoint lives in the api app (`apps/api/app/api/mcp/route.ts`
when built), not in a new `apps/mcp`. The api app already owns every
`/api/*` route, the Better Auth instance, and the DB-backed services; an
MCP endpoint is an API route, and a separate app would duplicate that
wiring for one endpoint. The dashboard app does not host it (it owns no
API routes).

Cloudflare Workers note: Streamable HTTP is plain POST plus an optional
per-response SSE stream — no long-lived connection is required, and the
stateless `2026-07-28` revision (no sessions, no GET stream) fits
Workers better than the sessionful revisions did. The endpoint still
needs a live check on the Workers build when it is built (same as any
new api route).

## Decision 4 — Auth: API keys are a prerequisite (the honest blocker)

MCP callers are external clients (Claude Desktop, IDEs, agents). They
cannot use the dashboard's session cookie — there is no browser, no
cookie jar, and no login flow to complete. They need a per-user bearer
**API key**.

API keys do **not** exist in SendCMS (audit §9 lists them as a new
capability: new models, dashboard UI for create/revoke/rotate, key
scoping). So the MCP build is **blocked on the api-keys capability**.
Until that exists, there is no MCP endpoint — a session-cookie
authenticated MCP endpoint would only work for the owner's own browser
and would be a fake.

When API keys exist, the auth rule is the same as the REST routes: the
key resolves to a `userId`, and every tool call goes through the same
`*ForUser` service functions, so a key can never see another owner's
domains, forms, or submissions. Keys are per-user (no per-form keys in
v1), revocable, and logged in the audit log like any other sensitive
action (ADR 0008).

## Decision 5 — Layered flow: MCP tools are thin handlers

MCP tools follow the same hard rule as REST routes (repo `AGENTS.md`):
thin handlers — parse, validate, call a service, return (≤25 lines).
They import from `@sendcms/shared` and the modules, never from
`@sendcms/database` directly, and never from `next/*`. The MCP package
(when built) depends on the modules + `@sendcms/shared` + the MCP SDK;
it owns no business logic of its own.

## Decision 6 — Package shape (when built)

- `packages/mcp` (`@sendcms/mcp`, private): the MCP server + the tool
  definitions (one tool module per capability, following the
  `packages/modules/*` layout). The route in `apps/api` is a thin
  adapter that hands the request to the package's server.
- No `apps/mcp`. No new service/worker (the MCP endpoint is request/
  response; there is no background workload to host).
- SDK dependency: `@modelcontextprotocol/sdk` **1.32.2** (latest stable,
  verified live via `npm view` 2026-11-19). It is **not** added to any
  `package.json` in this docs-only phase — pin it at build time, when
  the then-latest stable is checked again.

## What is explicitly not in this phase

No code, no package, no route, no dependency, no endpoint, no test.
The design above is the deliverable. Nothing here is callable, and no
MCP client can connect to SendCMS today.

## Build order (when the owner says build)

1. **API keys capability** (prerequisite): models, dashboard UI
   (create/revoke/rotate), key hashing + scoping, audit-log coverage.
   This is a separate design + build, not part of MCP.
2. **`packages/mcp` + the `/api/mcp` route**, read-only tools first,
   then mutations — each tool gated by the existing journey-style
   checks (owner scoping, validation, audit logging).
3. **Rate limiting for the MCP endpoint.** The admin-API rate-limit
   gap from ADR 0008 applies here too — an MCP endpoint without rate
   limits is an abuse vector. The public submit's DB-backed limits are
   the pattern to follow, not a limiter copied from elsewhere.
4. **User docs**: an MCP guide in `apps/docs` (connecting a client,
   creating a key, the tool list) — the docs app already renders the
   repo's user docs.

## Verification (2026-11-19)

- The tool table was written against the real module surface, verified
  by grepping the service exports (`packages/modules/*/src/service.ts`)
  and the route inventory (`apps/api/app/api/**/route.ts`, 21 files) on
  2026-11-19 — every listed function exists; the "not tools" list
  matches capabilities that genuinely don't exist (no user mutations,
  no API keys).
- The SDK version (`@modelcontextprotocol/sdk` 1.32.2) was verified
  live via `npm view` 2026-11-19. The transport facts (Streamable HTTP
  introduced in spec `2025-03-26`, HTTP+SSE deprecated since then, the
  `2026-07-28` revision stateless) were verified via web search
  2026-11-19 against the spec changelog and transport docs.
- No code changed in this phase, so the gates are a no-op confirmation:
  typecheck / lint / tests are re-run before the commit to confirm
  nothing moved (they must match the Phase 10 numbers: typecheck
  25/25, lint 0 errors / 1 pre-existing warning, tests 227/227).
