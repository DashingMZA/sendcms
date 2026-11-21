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
  + api builds pass.
- Open: no payments (Phase 8); no public pricing route (Phase 8);
  quota guards are pre-insert checks (concurrent overshoot by one
  possible — documented); emergency flag needs a restart to apply.

### Phase 5 — AI provider & BYOK architecture — PENDING

Per the BYOK design above. Provider resolution: BYOK → platform →
no AI. Never silently fall back BYOK → platform. Envelope encryption,
key versioning + rotation, cost attribution (platform vs BYOK vs failed).

### Phase 6 — MCP controls — PENDING

Global/per-user/plan controls, scopes, quotas, tool permissions,
analytics, revocation — enforced by the MCP service itself.

### Phase 7 — Platform operations — PENDING

Feature flags, announcements, admin notes, abuse/spam management, audit
log explorer, platform health, support architecture prep, data export &
deletion workflows, translation management UI.

### Phase 8 — Marketing & customer integration — PENDING

Pricing reads the same plan records; billing-provider abstraction
(PayPal, Stripe, Gumroad, Freemius, Polar.sh) — design only, no fake
payments. Customer `/dashboard/ai` settings page.

### Phase 9 — Hardening & verification — PENDING

Full acceptance matrix (spec §23 + additional requirements §7: 15
proofs), CSP, rate limiting, step-up re-auth, final report.

## Docs (under `docs/admin-control-plane/`)

- `implementation-audit.md` — Phase 1 record (done).
- `implementation-plan.md` — this file.
- Still to write as phases land: `architecture.md`, `database-design.md`,
  `authorization.md`, `plans-and-entitlements.md`, `usage-metering.md`,
  `ai-byok.md`, `mcp-management.md`, `plan-versioning.md`,
  `ai-billing-and-access.md`, `admin-audit-trail.md`,
  `internationalization.md`, `translation-management.md`,
  `implementation-report.md`.
