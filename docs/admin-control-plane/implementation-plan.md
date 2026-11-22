# Admin Control Plane — Implementation Plan

Branch: `feature/admin-control-plane` (cut from `feature/ai` @ `843ce3b`, 2026-11-21).
`main` and `feature/ai` are never modified by this work. No push or deploy
without the owner's explicit approval.

## Owner decisions (2026-11-21, recorded in `~/MEMORY.md`)

- **Admin host:** `admin.sendcms.bond`, env-driven via `NEXT_PUBLIC_ADMIN_URL`,
  never hardcoded (owner will move to a cheaper .com later).
- **Billing providers for the Phase 8 abstraction:** PayPal, Stripe, Gumroad,
  Freemius, Polar.sh.
- **Staff roles (admin app):** Super Admin (full access except managing
  administrators), Manager (limited rules), Support (support queries only).
  Dashboard keeps user roles only — everyone sees the same data there.
- **i18n:** English + Urdu first (covers LTR + RTL); the other 8 locales
  later. Domain-based JSON files, `packages/i18n/locales/{locale}/`
  with `admin/` and `dashboard/` subfolders. Language detected from the
  browser/system (`navigator.language`); a popup asks whether to stay in
  English or switch; the choice is stored in the browser (cookie) AND the
  database (`User.locale`), so it follows the user across devices.
- **Theme/UI/CSS:** the admin app reuses the dashboard's theme, UI
  components, and CSS verbatim — no new theme.
- **"Build the rest, I'll change it from the admin later":** everything
  admin-configurable, not hardcoded.

## BYOK design (clarified by the owner 2026-11-21; Phase 5)

1. **Platform/master key** (the system's own key, runs by default) lives in
   `.env` with model/provider/etc., same as MCP/AI today. Admin controls
   whether it is enabled and for which users/plans (all users vs which paid
   plans).
2. **Customer BYOK:** paid or free users may use their own key + model +
   provider. When a user selects their own key, the platform key PAUSES for
   that user until they re-enable it.
3. **Storage choice popup (on save/test):** "Browser only" (key stays in
   this browser only, never on the server; works only from that browser,
   background jobs cannot use it) or "Both (browser + server)" (stored
   encrypted in the DB, works from any browser/device the user logs into).
4. **Test button with EVERY saved key** so the user can check anytime
   whether the key is live.
5. **One key per provider per user** (up to 5: OpenAI, Anthropic, Google,
   DeepSeek, OpenRouter).
6. **SECURITY — encryption, NOT hashing:** a hash is one-way, so a hashed
   key can never be used to call a provider. Customer keys are stored
   ENCRYPTED (envelope encryption, master key in `.env` outside the DB).
   The DB holds only ciphertext; only the system can decrypt and use it.
   Do NOT hash BYOK keys.

## Phase status

### Phase 1 — Architecture & audit — DONE (2026-11-21)

`docs/admin-control-plane/implementation-audit.md`. Four read-only
inspections (schema, auth/permissions, MCP/AI/API-keys, apps/UI/deployment).
Key findings: no plans/subscriptions/entitlements/usage models; no user
status column; capability system skeletal; no BYOK; no MCP admin controls;
audit gaps; no i18n at all; no CSP/rate-limit/step-up.

### Phase 2 — Admin app & authorization — DONE (2026-11-21)

- `packages/i18n` — registry for exactly 10 locales (en + ur complete,
  other 8 coming-soon), translator, Intl formatting, domain loader,
  validation script. en + ur: 20 files, 358 keys, 100% in sync.
- `apps/admin` — Next 16, port 3006, dashboard theme/CSS copied verbatim.
  Proxy gates `/admin/*` on `VIEW_ADMIN_DASHBOARD` (owner-only until
  Phase 3's `User.adminRole` field lands); unauthenticated users go to the
  dashboard sign-in with a callback. Overview is a real page; the other
  sections are honest "planned" empty states — no fake data.
- `packages/permissions` — 23 admin capabilities, `AdminRole`
  (SUPER_ADMIN / MANAGER / SUPPORT), `ADMIN_ROLE_CAPABILITIES`,
  `adminCan()`. `/admin` → `VIEW_ADMIN_DASHBOARD`.
- `User.locale` (`String?`, migration `20261121201308_add_user_locale`,
  25/25 migrations applied) + `setUserLocale`/`getUserLocale` in
  `@sendcms/users` + `POST /api/v1/users/me/locale` on the api app.
- Language prompt + selector (cookie `sendcms-locale`, 1-year; best-effort
  POST to the locale route; never blocks the UI).
- Gates: root typecheck 0, lint 0, tests 316/316 (36 files), i18n
  validation en + ur 100%, admin + dashboard + api builds all pass.

Honest limits: staff-role enforcement is owner-only until Phase 3;
only the Overview page is real; the 8 coming-soon locales have no files.

### Phase 3 — Admin overview & user management — DONE (2026-11-21)

- Schema: `User.status` (ACTIVE/SUSPENDED/DISABLED), `User.adminRole`
  (SUPER_ADMIN/MANAGER/SUPPORT, nullable), `statusReason`,
  `statusChangedAt`, `deletionRequestedAt`/`deletionRequestReason`,
  `AdminNote` model. Migrations `20261121212116_add_user_status_admin_role_notes`
  - `20261121212357_add_user_deletion_request` (27/27 applied).
- Auth: session carries `status` + `adminRole` (additionalFields);
  `auth()` returns null for non-ACTIVE users; both proxies enforce
  suspension; admin proxy enforces staff roles via `adminCan`.
- `packages/modules/admin-users` (`@sendcms/admin-users` — the name
  `@sendcms/admin` was already taken by the app): 16 service functions
  with in-service authorization + guards (owner never suspendable,
  no self-suspend/self-role-change, MANAGER cannot change roles),
  validators, React Query hooks, 16 api routes, email sender via
  Better Auth's API. Tests 28/28.
- Admin UI: `/admin/users` (search, status/role/verified filters
  incl. "no staff role", pagination) + `/admin/users/[userId]` with
  8 tabs (Profile + 11 actions, Forms, Domains, Submissions with
  masked-by-default reveal + access audit, Package/AI planned in
  Phases 4/5, MCP keys list, Audit + notes). i18n `admin/users.json`,
  178 keys, en + ur 100%.
- **Phase 2 defect fixed:** the admin layout lived in the `(admin)`
  route group and never wrapped any page — the app rendered without
  its sidebar. Moved to `app/admin/layout.tsx`; the dead group layout
  is deleted. Sidebar now renders on `/admin/*` (visual check owed).
- Gates: typecheck 0, lint 0, tests 344/344 (37 files), i18n 21 files /
  536 keys en + ur 100%, admin + dashboard + api builds pass.
- Open: email sends (verification/reset) are source-verified only, not
  live-tested; visual check of the sidebar + RTL owed.

### Phase 4 — Plans & entitlements — DONE (2026-11-21)

- Schema already applied by the parent (migration
  `20261121224247`, 28/28): `Plan`, `PlanVersion` (immutable),
  `Subscription`, `SubscriptionEvent` (append-only),
  `UsageLedger` (idempotencyKey @unique), `EntitlementOverride`.
- `packages/modules/plans` (`@sendcms/plans`): `PlanEntitlementsSchema`
  (strict Zod) + `FREE_PLAN_V1_ENTITLEMENTS` (mirrors today's hardcoded
  limits: API keys 10, AI 100/day, MCP 120/min + 2000/hour, rest
  unlimited); plan CRUD + versioning (publish supersedes, archive,
  duplicate, field-level version comparison); subscriptions (assign in
  one transaction, migration preview + execute for selected users
  only, cancel now / at period end); `getEffectiveEntitlements`
  (precedence: emergency → suspension → override → subscription's
  effective version → default Free plan; `ensureDefaultFreePlan`
  idempotent under concurrency); usage metering (`recordUsage`
  idempotent, `getUsage`, `checkLimit`, `consumeQuota`); overrides
  (upsert by [userId, meter], reason required; API_KEYS/MCP null
  rejected); React Query hooks. 18 api routes under
  `/api/v1/admin/`. Tests 42/42.
- Root `config/config.json` created (`platform.emergency: false`) —
  the emergency switch; read by the service (workspace-root walk,
  cached, default off). No root config file or runtime loader existed
  before this phase.
- Enforcement (all fail-open): form create (FORMS), domain register
  (DOMAINS), API key create (API_KEYS, constant kept as fallback),
  MCP rate limit (per-key-owner entitlements), AI rescore cap value
  now from the form owner's entitlements (per-form usage counter
  unchanged — documented), public submit (SUBMISSIONS monthly quota,
  402 only when exhausted; ledger row on accept, best-effort).
- Docs: `docs/admin-control-plane/plans-and-entitlements.md`.
- Admin UI: `/admin/plans` (list + create), `/admin/plans/[planId]`
  (current version, version history, publish, duplicate, archive,
  field-level version comparison), `/admin/subscriptions` (list,
  assign, cancel), `/admin/subscriptions/migrate` (4-step wizard:
  target → scope → preview → confirm), `/admin/usage` (per-user
  per-meter, user-picker-first — no global list endpoint), user
  detail Package tab real (subscription + overrides + event history).
  i18n `admin/plans.json` + `admin/subscriptions.json` +
  `admin/usage.json`, en + ur 100% (24 files / 847 keys).
- **Migration execute fix (parent, after UI):** `executeMigration`
  now accepts `allOnVersionId` and resolves EVERY active
  subscription on that version server-side — the wizard used to
  execute only the previewed first 100. `usePlan("")` no longer
  fires (hook has an `enabled` guard).
- Gates: typecheck 0, lint 0, tests 387/387 (38 files, 43 plans
  tests), i18n 24 files / 847 keys en + ur 100%, admin + dashboard
  - api builds pass.
- Open: no payments (Phase 8); no public pricing route (Phase 8);
  quota guards are pre-insert checks (concurrent overshoot by one
  possible — documented); emergency flag needs a restart to apply.

### Phase 5 — AI provider & BYOK architecture — DONE + PUSHED 2026-11-21 (remote @ `414676a`)

Schema (migrations `20261121233835_add_ai_byok_keys_usage` +
`20261121234141_add_user_ai_settings`, 30/30 applied): `UserAiKey`
(one per provider, envelope-encrypted — never hashed, never
plaintext), `AiProviderConfig` (admin on/off + allowed/default
models per provider), `AiUsageRecord` (per-call attribution: BYOK vs
PLATFORM, tokens when reported, costMicros only when reliable),
`UserAiSettings` (billing mode BYOK/PLATFORM/DISABLED, default
PLATFORM). Encryption (`packages/ai/src/byok-crypto.ts`, written by
the parent, round-trip + AAD-binding verified): AES-256-GCM, per-key
random DEK, master key `AI_BYOK_MASTER_KEY` in .env (documented in
`.env.example`); `getAiModelForKey` builds a model from any explicit
key. `packages/ai/tsconfig.json` now lists `"types": ["node"]` (the
package already had @types/node; the crypto module needs Node types).

Services (`packages/modules/ai-settings/`, `@sendcms/ai-settings`):
BYOK save (upsert, keyVersion++ on replace) / list / get / enable /
disable / delete — metadata only (fingerprint last4, never key
material); Test button (`testUserAiKey`, one-token generateText probe,
records a key-test BYOK usage row either way); billing mode get/set
validated against the effective plan entitlements
(aiByokAllowed/aiPlatformAllowed), suspended users refused;
`resolveAiModelForUser` — browser-only key → stored BYOK key →
platform key → `AiNotAvailableError`; a missing/disabled/failing
BYOK key NEVER silently falls back to platform (proven by tests).
The only fallback is store-availability: when the settings store
itself is unreadable the mode is unknown, so the platform default is
used (`resolveAiModelLegacy`) — never a key fallback. Existing
capabilities (spam rescore, digest, suggestFields, draftReply) are
wired through per-owner resolution with the same degrade-to-non-AI
behaviour; capability routes accept `browserKey` + `browserProvider`

- `browserModel`. Admin: provider configs, health (counts only),
  usage list + BYOK-vs-platform summary, per-user keys (metadata) +
  billing mode. 14 API routes (customer `ai/keys/*` incl.
  `test-browser`, `ai/billing-mode`; admin `admin/ai/*`).
  Tests: `tests/ai-byok.test.ts`, 41 tests. Docs:
  `docs/admin-control-plane/ai-byok.md` + `ai-billing-and-access.md`.

UI: admin `/admin/ai` (overview), `/admin/ai/providers`,
`/admin/ai/models`, `/admin/ai/usage`, `/admin/ai/settings`
(emergency flag display-only, with the plain sentence that it never
disables form submission, the inbox, or non-AI services); the
user-detail AI tab is REAL (billing mode + keys metadata + per-user
usage); dashboard `/dashboard/ai` — billing-mode selector with the
"platform key paused" notice under BYOK, one card per provider with
save/test/enable/disable/delete, the storage popup on save AND test
("Browser only" vs "Both (browser + server)"), Test button with
every key. i18n: `admin/ai.json` (100 keys) + `dashboard/ai.json`
(53 keys) en + ur, real Urdu.

**Browser-only live test (fixed by the parent after the UI
subagent's report):** the test route first only tested server-stored
keys. Added `testBrowserKey` + `POST
/api/v1/ai/keys/[provider]/test-browser` — the raw key is sent for
one live probe and never stored or logged (only a key-test BYOK
usage row, no resourceId); the dashboard now calls it for
browser-only keys and shows the result on the card. 3 tests added
(live test without storing, failed test without fallback, too-short
key rejected). The shared probe was extracted (`probeKey`) and
`testUserAiKey` rewritten on top of it — its 38 tests still pass
unchanged.

**Bugs/gaps found and fixed in Phase 5:** `toAiCallUsage` read
`promptTokens`/`completionTokens` but AI SDK 7 reports
`inputTokens`/`outputTokens` — usage would always have been null
(fixed in `packages/ai/src/provider.ts`, both shapes accepted);
provider config/health had no capability check (now MANAGE_AI).

Gates (verified by the parent): root typecheck 0, lint 0, **tests
428/428 (39 files, 41 BYOK tests)**, i18n validation 26 files /
1000 keys en + ur 100%, admin + dashboard + api builds pass
(admin: all 5 AI routes; api: all 14 AI routes incl. test-browser;
dashboard: /dashboard/ai). `pnpm-lock.yaml` settled (only the
ai-settings + i18n workspace links added).
Open: no live verification against a real provider or the dev DB
(all tests mocked — a live journey with a real Gemini key and a real
BYOK save/test/resolve is still owed); dashboard shell is still
`lang="en"` with no `dir` handling (the /dashboard/ai content is
translated, full dashboard RTL is a follow-up); the dashboard
sidebar "AI" label is hardcoded English like every other dashboard
sidebar label. **PUSHED 2026-11-21 (remote @ `414676a`; local
`f4d0d19`, tree `57bb25f` verified; 77 files, 7,573 insertions).
Push log: `~/workspace/push-admin-phase5.log`.**

### Phase 6 — MCP controls — DONE (backend; admin UI pages follow)

Global/per-user/plan controls, scopes, quotas, tool permissions,
analytics, revocation — enforced by the MCP service itself, not only
by the UI.

- **Permissions:** `VIEW_MCP` added (`packages/permissions/src/
platform.ts`); owner = all, SUPER_ADMIN = all admin caps except
  `MANAGE_ADMINISTRATORS` (so it gets `VIEW_MCP`), MANAGER and
  SUPPORT both get `VIEW_MCP`. Writes stay `MANAGE_MCP`.
  `tests/permissions.test.ts` role-map assertions updated.
- **Enforcement (`packages/mcp/`):** `src/tools/names.ts` is the
  single 19-tool registry (`MCP_TOOL_NAMES`, `MCP_READ_TOOL_NAMES`,
  `isMcpToolName`); all 19 registrations wrapped in
  `isToolAllowed(auth, name)` (alongside the READ-scope mutation
  gate). `src/access.ts` — `checkMcpAccess({ auth, tool? })` enforces
  in order: (a) kill-switch off → 503, (b) revoked key → 401
  (existing, in `resolveMcpAuth`), (c) suspended/disabled owner →
  403, (d) per-user disabled → 403, (e) tool outside the allowlist
  → 404 "Tool X not found" (same wording as the READ-scope
  behaviour), (f) quota overrides returned for the rate limiter.
  `parseMcpAllowedTools` exported (corrupt Json fails open to
  "every tool the scope allows" + a warning log). `src/rate-limit.ts`
  — `checkMcpRateLimit(keyId, overrides)` precedence: per-user
  override → plan entitlements (`getEffectiveEntitlementsSafe`) →
  platform defaults 120/min + 2000/hour; same DB-backed counters,
  429 without incrementing, fail-open to the defaults when the
  entitlements lookup fails. `src/usage.ts` — `recordMcpUsage` /
  `recordMcpCallOutcomes` / `extractMcpCallOutcomes` (pure):
  one row per executed call (tool, status, durationMs), best-effort
  and awaited, never any arguments/results; non-`tools/call`
  methods and unmatched responses record nothing. The route
  (`apps/api/app/api/mcp/route.ts`) calls `checkMcpAccess` for
  every request (tools/call with the tool name, everything else
  without) and the rate limiter for `tools/call` before execution.
- **Service (`packages/modules/mcp-admin/`, `@sendcms/mcp-admin`):**
  `getMcpSettings` (upserts the singleton row, fixed id
  `"platform"`), `setMcpSettings` (MANAGE_MCP, reason required,
  audited `mcp-global-toggled` with old/new); `getUserMcpSettings`
  (defaults when no row), `setUserMcpSettings` (MANAGE_MCP, reason
  required, audited `mcp-user-settings-changed` with old/new;
  tool names validated against `MCP_TOOL_NAMES`; 0/negative
  quotas rejected 422 — use the enable switch to block);
  `listMcpUsage` + `getMcpUsageSummary` (VIEW_MCP; totals,
  per-tool counts, per-user top 10, last-24h error rate);
  `listMcpKeys` (owner, scope, 30-day call count via one groupBy;
  never selects `keyHash`) + `revokeMcpKey` (MANAGE_MCP, reuses
  `@sendcms/api-keys` revoke, then logs a second admin audit row
  `mcp-key-revoked` with the reason — the two rows together are
  the key-lifecycle record and the admin action). No owner
  protection / self-target ban on MCP settings (deliberate —
  disabling MCP never locks anyone out of the dashboard). React
  Query hooks in `src/queries.ts`. 6 thin routes under
  `apps/api/app/api/v1/admin/mcp/` (settings, users/[userId]/
  settings, usage, usage/summary, keys, keys/[keyId]/revoke).
- **Docs:** `docs/admin-control-plane/mcp-management.md`
  (kill-switch, per-user controls, quota precedence, usage
  analytics, what is NOT recorded, revocation, the empty-allowlist
  `-32601` edge case).
- **Gates:** root typecheck 0, mcp + mcp-admin + api typecheck 0,
  lint 0, **tests 480/480 (40 files; 52 new in
  `tests/mcp-admin.test.ts`)**, prettier clean, `pnpm --filter
@sendcms/api build:server` passes with all 6 new routes in the
  build. Fixes made during verification: `Prisma` value import
  (TS1361 on `Prisma.JsonNull`), top-users `orderBy`
  `{ _count: { userId: "desc" } }` (`_all` is not a valid order
  key), `setMcpSettings` reads the old value with `findFirst`
  (consistent with `checkMcpAccess`), the keys mock handles the
  service's `select.user` shape, and the empty-allowlist test
  asserts the SDK's `-32601 Method not found` (the SDK serves no
  `tools/list` handler when zero tools are registered).
- **Open:** admin UI pages (`/admin/mcp/*`) are the next step —
  the hooks already exist. No live verification against a real
  MCP client yet (tests use an in-memory transport with mocked
  services). No per-tool quota — only per-key minute/hour limits.

### Phase 7 — Platform operations — DONE (services + UI)

Backend + admin UI done (see `platform-operations.md` +
`admin-audit-trail.md`): DB-backed feature flags (override →
global → off, fail-closed), announcements (active window +
audience, never deleted), audit trail (`reason`/`correlationId`/
`outcome`, idempotency, immutable), platform health + system
summary (real queries only), abuse/spam queue (metadata-only list,
audited sensitive reads, inbox transition rules), deletion workflow
(REQUESTED → APPROVED → COMPLETED, anonymizing erasure,
billing/audit history kept), translation completion (loader-based,
read-only). Admin UI: `/admin/features`, `/admin/announcements`,
`/admin/audit-logs` (replaces the dead `/admin/activity`),
`/admin/health`, `/admin/settings` (system summary, replaces the
Phase 2 planned empty state), `/admin/submissions`, `/admin/security`,
`/admin/translations`, plus the dashboard announcement banner
(audience ALL, dismissible). Support architecture prep was a design
note, not a build. Tests: `tests/platform-ops.test.ts`, 31 tests;
full suite 511/511. i18n: 35 files / 1359 keys en + ur 100%.
Known open items: no live verification against the real dev DB; UI
click-through owed (incl. RTL rendering of the new pages).

### Phase 8 — Marketing & customer integration — DONE

- **Public plans + pricing:** `listPublishedPlans` in `@sendcms/plans`
  (PUBLISHED, non-private plans only — current published version with
  price + entitlements, no draft/internal fields) + public route
  `GET /api/public/v1/plans` (no auth) + marketing `/pricing` page
  reading those records live (no hardcoded prices; honest error state
  when the API fails). The homepage's content-driven pricing section
  is untouched (follow-up).
- **Billing (`@sendcms/billing`, `packages/modules/billing/`):**
  provider registry (Stripe → PayPal → Polar → Freemius → Gumroad,
  env-var config checks, SDKs latest stable), admin enable/disable
  gated on env presence (422 naming the missing vars), per-provider
  countries via the `Country` + `BillingProviderCountry` tables (no
  rows = all countries; PATCH validates codes, 422 on unknown;
  customer country from IP geo headers with a manual-select
  fallback), checkout (Stripe Checkout Session + signature-verified
  webhook → subscription ACTIVE; PayPal Product→Plan→Subscription +
  verified webhook; Polar/Freemius API-created hosted checkout +
  webhooks; Gumroad registered-only, NO automated checkout — clear
  422, never fake), webhook idempotency via `BillingEvent`, and
  subscription activation reusing the Phase 4 `assign` flow (webhook
  re-reads the plan version from the DB, never trusts client prices).
  Admin page `/admin/billing`, dashboard `/dashboard/billing` +
  `/dashboard/billing/checkout` (proper pages; confirmation dialog
  only at confirmation time). Countries table seeded with all 249
  ISO codes (migration `20261122050526_add_countries_table`).
  `VIEW_BILLING` / `MANAGE_BILLING` capabilities (MANAGER reads
  only). Docs: `billing-providers.md`.
- **Tickets (`@sendcms/support`, `packages/modules/support/`):**
  customer create/list/get/reply (reply reopens RESOLVED, refused
  409 on CLOSED; another user's ticket is a 404, never a 403),
  admin list/get/reply/status/assign with the `TICKET_TRANSITIONS`
  machine and reason-required audited writes; reply, status change
  and assignment need `MANAGE_USERS` or the SUPPORT role (owner
  decision 2026-11-22 — support staff exist to answer tickets).
  Dashboard `/dashboard/support` (+ `/new`, `+ /[ticketId]`),
  admin `/admin/support` (+ `/[ticketId]`), all proper pages.
  `TICKET_TRANSITIONS` lives in a pure `transitions.ts` so client
  components can import it without pulling `@sendcms/database` into
  the browser bundle. Docs: `support.md`.
- **Feature-flag wiring:** the AI background jobs are gated by
  DB-backed flags — `ai-spam-rescore` guards `rescoreNewSubmissions`,
  `ai-digest` guards `sendDueDigests` (flag missing/disabled = job
  off, fail-closed; the admin creates and enables them in
  `/admin/features`). Gating lives in the jobs themselves, so it
  covers both the cron route and the email worker.
- **Schema:** migration `20261122050016_add_billing_support_tickets`
  (`BillingProviderConfig`, `BillingEvent`, `SupportTicket`,
  `TicketMessage`, `Subscription.provider` +
  `providerSubscriptionId`) and `20261122050526_add_countries_table`
  (`Country`, `BillingProviderCountry`, 249-code seed). Dev DB 34/34.
- **Gates:** root typecheck 0, lint 0, **tests 553/553 (43 files;
  21 new in `tests/billing.test.ts`, 19 in `tests/support.test.ts`,
  2 new flag-gating tests)**, prettier clean, i18n en + ur 100%
  (39 files), admin + dashboard + api + marketing builds pass with
  every new route in the manifests. All `package.json` files
  re-normalized to the standard order (`--check` clean, incl.
  `apps/admin`).
- **Open:** no live payment test (needs real Stripe test-mode keys
  on the owner's machine); Freemius plan mapping is manual
  (`FREEMIUS_PLAN_MAP`); no per-ticket email notifications; no live
  verification of the new pages against the real dev DB (user visual
  check owed); the real DB-backed admin overview (spec §3) was never
  built — Phase 9 candidate.

### Phase 9 — Hardening & verification — PENDING

Full acceptance matrix (spec §23 + additional requirements §7: 15
proofs), CSP, rate limiting, step-up re-auth, final report.

## Docs (under `docs/admin-control-plane/`)

- `implementation-audit.md` — Phase 1 record (done).
- `implementation-plan.md` — this file.
- `plans-and-entitlements.md` — Phase 4 record (done).
- `ai-byok.md` — Phase 5 record (done).
- `ai-billing-and-access.md` — Phase 5 record (done).
- `mcp-management.md` — Phase 6 record (done).
- `platform-operations.md` — Phase 7 record (done).
- `admin-audit-trail.md` — Phase 7 record (done).
- `billing-providers.md` — Phase 8 record (done).
- `support.md` — Phase 8 record (done).
- Still to write as phases land: `architecture.md`, `database-design.md`,
  `authorization.md`, `usage-metering.md`, `plan-versioning.md`,
  `internationalization.md`,
  `translation-management.md`, `implementation-report.md`.
