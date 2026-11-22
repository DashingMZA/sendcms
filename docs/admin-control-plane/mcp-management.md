# MCP management (Admin Control Plane, Phase 6)

Admin controls for the MCP endpoint (`POST /api/mcp`), enforced by the
MCP service itself — not only by the admin UI. Every control changed
in the admin app takes effect on the next MCP request.

## What exists

| Control                                                     | Where                                                                      | Capability                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| Global kill-switch (`globalEnabled`)                        | `GET/POST /api/v1/admin/mcp/settings`                                      | read `VIEW_MCP`, write `MANAGE_MCP`  |
| Per-user controls (enable, tool allowlist, quota overrides) | `GET/POST /api/v1/admin/mcp/users/[userId]/settings`                       | read `VIEW_MCP`, write `MANAGE_MCP`  |
| Usage history + summary                                     | `GET /api/v1/admin/mcp/usage`, `GET /api/v1/admin/mcp/usage/summary`       | `VIEW_MCP`                           |
| Keys list + revoke                                          | `GET /api/v1/admin/mcp/keys`, `POST /api/v1/admin/mcp/keys/[keyId]/revoke` | read `VIEW_MCP`, revoke `MANAGE_MCP` |

Service module: `packages/modules/mcp-admin/` (`@sendcms/mcp-admin`) —
`src/service.ts`, `src/validators.ts`, `src/queries.ts` (React Query
hooks for the admin pages). Enforcement lives in
`packages/mcp/src/access.ts` (`checkMcpAccess`), `src/rate-limit.ts`
(`checkMcpRateLimit`), `src/usage.ts` (recording), and the tool
registration in `src/tools/*.ts`. Routes are thin handlers under
`apps/api/app/api/v1/admin/mcp/`.

## The global kill-switch

`McpSettings` holds one row (fixed id `"platform"`, created on first
read). When `globalEnabled` is `false`, `checkMcpAccess` refuses
EVERY MCP request with **503 "MCP is temporarily disabled by the
platform administrator."** — `tools/call` and `tools/list` alike
(`initialize`/`ping` too: the check runs before the server executes
anything).

The kill-switch is MCP-only. It never touches form submission, the
inbox, or any non-MCP service. It is separate from the Phase 4
emergency flag in `config/config.json`, which zeroes AI + MCP and
needs a server restart; the kill-switch is a database row, so it
takes effect immediately and can be flipped back from the admin UI.

Toggling it requires a reason (`SetMcpSettingsSchema.reason`, max
500 chars) and is audited (`UPDATE` / `MCP_SETTINGS`, detail event
`mcp-global-toggled`, old + new values).

## Per-user controls

`McpUserSettings` (one row per user, `userId @unique`). Defaults when
no row exists: enabled, no allowlist, no quota overrides.

- **`isEnabled`** — `false` refuses every MCP call from that user's
  keys with **403 "MCP is disabled for this account by the platform
  administrator."** Use this to block a user; a zero quota is not a
  blocking mechanism (see below).
- **`allowedTools`** — `null` = every tool the key's scope allows;
  an explicit list = only those tools; an empty list = no tools at
  all. Entries must be real tool names — validated against the
  canonical 19-tool registry `MCP_TOOL_NAMES` in `@sendcms/mcp`
  (imported, never a second copy); an unknown name is rejected with 422.
- **`minuteLimit` / `hourLimit`** — per-user quota overrides, `null`
  = the plan's limits. When set, they must be positive integers; 0
  is rejected with 422 (a zero quota is not a way to block a user —
  use `isEnabled: false`).

Changes require a reason and are audited (`UPDATE` / `MCP_SETTINGS`,
detail event `mcp-user-settings-changed`, old + new values, never
any key material).

### Deliberate non-guards

Unlike suspension (Phase 3), MCP settings have **no owner
protection and no self-target ban**: an admin disabling MCP for a
user — including the platform owner, including themselves — is a
legitimate platform action. Disabling MCP does not lock anyone out
of the dashboard; it only stops their API keys from calling tools.

## Enforcement order (the route, every request)

`POST /api/mcp` resolves the key first (`resolveMcpAuth` — revoked
keys get 401 there, unchanged), then `checkMcpAccess` enforces, in
this order:

1. **Global kill-switch off → 503.** Every MCP call refused.
2. **Key revoked → 401.** Existing behaviour, kept.
3. **Key owner suspended/disabled (`user.status !== ACTIVE`) → 403.**
   The MCP route uses API-key auth, not session auth, so the status
   is checked explicitly here. A suspended user's keys stop working
   even though the keys themselves are still valid.
4. **Per-user `isEnabled: false` → 403.**
5. **Tool not in the user's allowlist (when set) → 404 "Tool X not
   found".** The same message a READ key gets for a mutation — the
   allowlist itself is never leaked.
6. **Quota** — resolved by the rate limiter (below).

A refusal before execution consumes no quota and writes no usage
row.

### Tool registration respects the allowlist too

One `McpServer` is created per request. Every one of the 19 tool
registrations is wrapped in `isToolAllowed(auth, name)` (alongside
the existing READ-scope mutation gate), so a disallowed tool never
appears in `tools/list` and cannot be called even if a client
guesses its name — the call would hit the 404 in step 5 first.
There is no second registration path. Note the edge case: with an
empty allowlist (zero tools registered) the MCP SDK does not serve
`tools/list` at all — a client asking for the list gets `MCP error
-32601: Method not found` instead of an empty list. That is the
observable proof that nothing is registered, and it is SDK
behaviour, not a route decision.

## Quota precedence

`checkMcpRateLimit(keyId, overrides)` — the same DB-backed
fixed-window counters as Phase 11 (`ApiKeyRateLimit`, one row per
key, minute + hour windows); no second counter system. Limits
resolve in this order:

1. **Per-user override** (`minuteLimit` / `hourLimit` from
   `McpUserSettings`, when non-null) — wins over the plan.
2. **The key owner's effective plan entitlements**
   (`mcpRequestsPerMinute` / `mcpRequestsPerHour` via
   `getEffectiveEntitlementsSafe` from `@sendcms/plans`).
3. **Platform defaults: 120/min + 2000/hour**
   (`MCP_MINUTE_LIMIT` / `MCP_HOUR_LIMIT` in
   `packages/mcp/src/rate-limit.ts`).

A call over the limit is rejected with 429 **without** incrementing
the counter, so the key stays limited until the window passes. If
the entitlements lookup fails, the defaults apply (fail-open) — a
plans-module error never blocks MCP calls. If the global settings
row does not exist yet, the kill-switch reads as enabled (fail-open).

## Usage recording

After every executed tool call, the route records one
`McpUsageRecord`: `apiKeyId`, `userId`, `tool`, `status`
(`SUCCESS` / `FAILED`), `durationMs` measured around the call. The
write is best-effort and never throws — a failed write is logged,
never surfaced to the client — and it is awaited before the route
returns (a fire-and-forget write can be cut off when a serverless
function returns).

**What is recorded:** the tool name, the outcome, the duration.

**What is NEVER recorded:** request arguments, results, or anything
that could hold customer data. The recorder (`extractMcpCallOutcomes`
in `packages/mcp/src/usage.ts`) is a pure function over the JSON-RPC
request/response: it matches responses to requests by `id`, records
only `tools/call` entries with a string `params.name`, marks a call
failed when the result has `isError: true` or the response is a
JSON-RPC `error`, and records nothing when no matching response
exists (the outcome cannot be established) or the method is not
`tools/call`.

Calls refused before execution (kill-switch, suspended/disabled
user, disallowed tool, over quota) are NOT recorded.

## Usage analytics

`listMcpUsage` (filter `userId` / `apiKeyId` / `tool` / `status` /
date range, paginated, newest first) and `getMcpUsageSummary`
(total calls, success vs failed, per-tool counts, per-user top 10,
last-24h error rate). Counts only. Both need `VIEW_MCP` — SUPPORT
holds it (support queries need MCP usage visibility); MANAGER and
SUPER_ADMIN hold it too.

## Keys: list + revoke

`listMcpKeys` returns every key with its owner (email/name), scope,
`lastUsedAt`, `revokedAt`, and its **30-day call count** from
`McpUsageRecord` (one `groupBy`, no N+1). The select never includes
`keyHash` — the plaintext key is unrecoverable by design, and the
hash must never leave the server.

`revokeMcpKey` (MANAGE_MCP, reason required) reuses the
`@sendcms/api-keys` revoke — it is not reimplemented. The key stops
working immediately. Two audit rows are written, and that is
deliberate:

- the api-keys row (`DELETE` / `API_KEY`, key name + scope) — the
  key-lifecycle record, actor = the key owner;
- the mcp-admin row (`DELETE` / `API_KEY`, detail event
  `mcp-key-revoked`, reason + owner id) — the admin action that
  caused it.

The per-user revoke-all already exists in `@sendcms/admin-users`
and is not duplicated here.

## Permissions

New capability: `VIEW_MCP` (reads — the MCP pages + usage).
`MANAGE_MCP` (writes) already existed. Role map (owner = all
capabilities; SUPER_ADMIN = all admin capabilities except
`MANAGE_ADMINISTRATORS`, so it gets `VIEW_MCP`; MANAGER and SUPPORT
both get `VIEW_MCP`).

## Tests

`tests/mcp-admin.test.ts` — see the file for the full matrix. It
proves: kill-switch off blocks `tools/call` (503) and `tools/list`;
a suspended user's valid key is refused (403); per-user disable
blocks (403); an allowlist hides tools from registration AND
refuses direct calls (404); a per-user quota override beats the
plan entitlements, the plan limit is honoured without an override,
and the 120/min + 2000/hour defaults apply when the plan has no
limits; a successful call records exactly one usage row with the
right tool/status and no arguments; a refused call records no row;
revoke delegates to `@sendcms/api-keys` and is audited; a settings
change without a reason is rejected.

## Known limitations

- Quota guards are the existing fixed-window counters — two
  concurrent calls at the exact limit can overshoot by one (same
  pattern as the rest of the codebase; the usage ledger is the
  audit trail).
- There is no per-tool quota — only per-key minute/hour limits.
- The admin UI pages (`/admin/mcp/*`) are built in the UI step
  after this backend; the hooks (`useMcpSettings`,
  `useUserMcpSettings`, `useMcpUsage`, `useMcpUsageSummary`,
  `useMcpKeys` + mutations) already exist in
  `@sendcms/mcp-admin/queries`.
- No live verification against a real MCP client yet — the tests
  use an in-memory transport with mocked services (same pattern as
  `tests/mcp-server.test.ts`).
