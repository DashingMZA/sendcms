# Implementation report (Admin Control Plane)

The final report for the SendCMS Admin Control Plane (spec §24):
what was built in each phase, the architecture and the decisions
behind it, how much of the acceptance criteria holds, what was
deferred, and what is still owed by the owner.

Branch: `feature/admin-control-plane` (cut from `feature/ai` @
`843ce3b`, 2026-11-21). Status at this report: Phases 1–9 built
and gated; **uncommitted** (HEAD is still `0395930`, the Phase 8
push). No merge, no deploy — both need the owner's explicit
approval.

## Contents

- [What was built, per phase](#what-was-built-per-phase)
- [Architecture](#architecture)
- [Decisions](#decisions)
- [Acceptance summary](#acceptance-summary)
- [Deferred items](#deferred-items)
- [Open items for the owner](#open-items-for-the-owner)

## What was built, per phase

### Phase 1 — Architecture & audit (2026-11-21)

Four read-only inspections (schema, auth/permissions, MCP/AI/
API-keys, apps/UI/deployment) and the audit record:
[implementation-audit](./implementation-audit.md). Findings:
no plans/subscriptions/entitlements/usage models; no user
status column; skeletal capabilities; no BYOK; no MCP admin
controls; audit gaps (no reason/correlation/outcome, no
reader/UI); no i18n; no CSP/rate-limit/step-up. No code
changed.

### Phase 2 — Admin app & authorization (2026-11-21)

- `apps/admin` (Next 16, port 3006): dashboard theme/CSS copied
  verbatim, proxy gates `/admin/*` on `VIEW_ADMIN_DASHBOARD`,
  shell + honest planned pages (no fake data).
- `packages/i18n`: 10-locale registry, translator, validation
  script; `en` + `ur` complete (20 files, 358 keys then).
- `packages/permissions`: the admin capability model
  (23 capabilities then — 26 now, see
  [authorization](./authorization.md)) + `AdminRole` +
  `adminCan`.
- `User.locale` (migration `20261121201308_add_user_locale`) +
  `POST /api/v1/users/me/locale`; language prompt + selector
  (cookie + DB persistence).
- Gates then: typecheck 0, lint 0, tests 316/316.

### Phase 3 — Overview & user management (2026-11-21)

- Schema: `User.status` / `adminRole` / `statusReason` /
  `statusChangedAt` / deletion-request fields, `AdminNote`
  (migrations `20261121212116` + `20261121212357`).
- Auth: `auth()` returns null for non-`ACTIVE` users;
  suspension enforced in both proxies.
- `@sendcms/admin-users`: 16 service functions with in-service
  authorization + owner/self guards, 16 API routes, admin email
  sender.
- Admin UI: `/admin/users` + `/admin/users/[userId]` (8 tabs).
- The "real stats" half of this phase's acceptance only landed
  in Phase 9 (the overview stayed the honest Phase 2 shell
  until then) — see
  [acceptance-matrix](./acceptance-matrix.md#part-b--per-phase-acceptance-audit-6-phases-29).
- Gates then: tests 344/344, i18n 21 files / 536 keys en + ur
  100%.

### Phase 4 — Plans & entitlements (2026-11-21)

- Schema: `Plan`, `PlanVersion`, `Subscription`,
  `SubscriptionEvent`, `UsageLedger`, `EntitlementOverride`
  (migration `20261121224247`).
- `@sendcms/plans`: versioned plans (edit → new draft version,
  publish supersedes, archive, duplicate, field-level
  comparison), subscriptions (assign in one transaction,
  migration preview + execute for selected users only, cancel),
  `getEffectiveEntitlements` (emergency → suspension →
  override → subscription's effective version → default Free
  plan), usage metering (idempotent ledger, `checkLimit`,
  `consumeQuota`), overrides.
- Server-side enforcement, fail-open: form create, domain
  register, API key create, MCP rate limit, AI rescore cap
  value, public submit (402 only when the submission quota
  itself is exhausted).
- Admin UI: `/admin/plans`, `/admin/subscriptions`,
  `/admin/subscriptions/migrate` (4-step wizard),
  `/admin/usage`, user-detail Package tab.
- Gates then: tests 387/387, i18n 24 files / 847 keys.
- Known limitation, still open: quota guards are pre-insert
  checks — two concurrent creates at the exact limit can
  overshoot by one.

### Phase 5 — AI provider & BYOK (2026-11-21)

- Schema: `UserAiKey` (envelope-encrypted), `AiProviderConfig`,
  `AiUsageRecord`, `UserAiSettings` (migrations
  `20261121233835` + `20261121234141`).
- Envelope encryption (`packages/ai/src/byok-crypto.ts`):
  AES-256-GCM, per-key random DEK, master key
  `AI_BYOK_MASTER_KEY` in `.env` outside the DB — encryption,
  not hashing, by the owner's explicit acceptance of the
  correction.
- `@sendcms/ai-settings`: BYOK CRUD (metadata only), Test
  button (one-token probe, failed test never falls back),
  billing mode BYOK/PLATFORM/DISABLED validated against plan
  entitlements, `resolveAiModelForUser` (browser-only key →
  stored BYOK → platform → error; a failing BYOK key never
  silently falls back).
- All four AI capabilities wired per-owner with usage recording
  (BYOK vs PLATFORM attribution, cost only when the provider
  reports it).
- Admin UI: `/admin/ai/*`; dashboard `/dashboard/ai` (billing
  mode, per-provider cards, storage popup, Test button).
- Gates then: tests 428/428, i18n 26 files / 1000 keys.
- Open: no live verification against a real provider or the
  dev DB (see [Open items](#open-items-for-the-owner)).

### Phase 6 — MCP controls (2026-11-21)

- Schema: `McpSettings` (singleton kill-switch),
  `McpUserSettings`, `McpUsageRecord` (migration
  `20261122010723`).
- Enforcement inside `@sendcms/mcp` (not the UI):
  `checkMcpAccess` (kill-switch 503 → revoked 401 → suspended
  403 → per-user disabled 403 → allowlist 404), quota
  precedence (per-user override → plan entitlements → 120/min
  and 2000/hour defaults), usage recording (tool, status,
  duration — never arguments/results).
- `@sendcms/mcp-admin`: settings, per-user settings, usage
  lists/summary, key list/revoke (delegates to
  `@sendcms/api-keys`, then a second admin audit row).
- Admin UI: `/admin/mcp/*`; user-detail MCP tab.
- Gates then: tests 480/480, 52 new in
  `tests/mcp-admin.test.ts`.
- Open: no per-tool quota; no live verification against a real
  MCP client.

### Phase 7 — Platform operations (2026-11-21/22)

- DB-backed feature flags (override → global → off,
  fail-closed), announcements (active window + audience, never
  deleted), audit trail (`reason` / `correlationId` /
  `outcome`, idempotency, immutable — the module exports no
  `AuditLog` mutation), health + system summary (real queries
  only), abuse/spam queue (metadata-only list, audited
  sensitive reads), deletion workflow (REQUESTED → APPROVED →
  COMPLETED, anonymizing erasure, billing/audit history kept),
  translation completion (loader-based, read-only).
- `@sendcms/platform-ops`; 21 API routes; 8 new admin pages +
  dashboard announcement banner.
- Feature-flag wiring (Phase 8): `ai-spam-rescore` guards
  `rescoreNewSubmissions`, `ai-digest` guards
  `sendDueDigests` (flag missing/disabled = job off).
- Gates then: tests 511/511, i18n 35 files / 1359 keys.
- Open: no live verification against the real dev DB.

### Phase 8 — Marketing & customer integration (2026-11-22)

- **Real payments, not design-only** (owner decision
  2026-11-22, superseding the audit's "abstraction only"):
  `@sendcms/billing` — Stripe, PayPal, Polar, Freemius hosted/API
  checkout + signature-verified webhooks + `BillingEvent`
  idempotency; Gumroad registered-only (it has no
  payment-creation API — checkout refuses with a clear 422,
  never fakes). Provider enablement gated on env presence (422
  naming the missing vars). Per-provider countries via the
  `Country` (249 codes) + `BillingProviderCountry` tables;
  customer country from IP geo headers with a manual-select
  fallback.
- Public plans (`GET /api/public/v1/plans`) + marketing
  `/pricing` reading live records (no hardcoded prices).
- Tickets (`@sendcms/support`): dashboard-only creation, admin
  reply/status/assign with the `TICKET_TRANSITIONS` machine;
  SUPPORT does full ticket work (owner decision 2026-11-22).
- Schema: migrations `20261122050016` + `20261122050526`.
  Dev DB 34/34 at push.
- Gates: tests 553/553, i18n 39 files / 1517 keys, all 4 builds
  pass. **Pushed 2026-11-22 (remote @ `0395930`).**
- Open: no live payment test (needs real Stripe test keys on
  the owner's machine); Freemius plan map is manual; no
  per-ticket notifications.

### Phase 9 — Hardening & verification (2026-11-22)

- **Real admin overview** (spec §3): `getAdminOverview` in
  `@sendcms/platform-ops` — user totals + new users + status
  split, submission totals + in-range status split + per-day
  series, form/domain totals, active subscriptions by plan,
  AI + MCP call counts — for 24h / 7d / 30d / 90d / 12mo /
  custom ranges. `GET /api/v1/admin/overview`
  (`VIEW_ADMIN_DASHBOARD`). Admin page rebuilt on it with
  Recharts visualizations. 17 tests
  (`tests/admin-overview.test.ts`).
- **Rate limiting** (closes ADR 0008 §6): generic
  `RateLimitBucket` + atomic upsert + fail-open; admin API
  600/min + 10,000/hour per user (78/78 admin routes wired,
  including the overview route), auth sign-in 20/min per IP +
  10/min per email. Migration
  `20261122064351_add_rate_limit_buckets`. 18 tests
  (`tests/admin-rate-limit.test.ts`). See
  [rate-limiting](./rate-limiting.md).
- **CSP**: nonce-based policy on every document response from
  the five page apps (`packages/security/src/csp.ts`);
  report-only run clean (caught the un-nonced theme script),
  flipped to enforcing (`CSP_REPORT_ONLY = false`). The
  dashboard `/sign-in` gap found in that pass is **closed**:
  the dashboard proxy matcher now covers the five auth pages
  with a pass-through that carries the CSP header. See
  [csp](./csp.md).
- **Step-up re-authentication**: `verifyStepUp` /
  `requireStepUp` in `@sendcms/security`; a password re-check
  writes a `StepUpVerification` row valid 10 minutes.
  Gated scope (owner decision 2026-11-22): user disable, admin
  role change, MCP kill-switch toggle, MCP key revoke, deletion
  review, deletion erasure. Migration
  `20261122070123_add_step_up_verification`. 21 tests
  (`tests/step-up.test.ts`). See
  [authorization](./authorization.md#step-up-re-authentication).
- **Acceptance matrix + docs**: this report's companion,
  [acceptance-matrix](./acceptance-matrix.md), plus the
  remaining docs — [architecture](./architecture.md),
  [database-design](./database-design.md),
  [authorization](./authorization.md),
  [usage-metering](./usage-metering.md),
  [plan-versioning](./plan-versioning.md),
  [internationalization](./internationalization.md),
  [translation-management](./translation-management.md).
- **Gates:** root typecheck 0, **tests 615/615 (46 files)**,
  lint 0, prettier clean, i18n en + ur 100% (41 files).
  Migrations in the tree: 36 (34 committed + 2 Phase 9,
  uncommitted until the push); the dev DB stands at 36/36
  after integration.

## Architecture

See [architecture](./architecture.md) for the full picture.
In short:

- **One auth system.** Better Auth 1.7.25, shared session
  cookie across the subdomain apps, `COOKIE_DOMAIN`
  `sendcms.bond` in production. The admin app owns its own
  Better Auth instance (thin `lib/auth.ts` wrapper), like the
  api and dashboard apps.
- **Thin routes → services → database.** 78 admin routes on
  the api app; services in `packages/modules/*` (seven new
  modules: `admin-users`, `plans`, `ai-settings`, `mcp-admin`,
  `platform-ops`, `billing`, `support`); only services import
  `@sendcms/database`. The admin app renders pages and proxies
  its `/api/v1/*` fetches to the api app — it has no API of
  its own.
- **Capability gating in the services.** 26 capabilities, 3
  staff roles, owner = all; `requireAdmin` per action, plus
  `requireTicketWrite` (SUPPORT ticket work) and
  `requireStepUp` (high-impact actions). The UI is never the
  boundary.
- **Append-only history everywhere it matters.** Audit log,
  subscription events, usage ledger, ticket messages, AI/MCP
  usage records, step-up verifications — none of them has an
  update or delete path in the admin interfaces.
- **Fail-open for the core path, fail-closed for the gates.**
  Entitlement and limiter errors never break submissions;
  unknown feature flags are off; unknown capabilities are
  denied.

## Decisions

The owner decisions that shaped this build (all recorded in
`~/MEMORY.md` and
[implementation-plan](./implementation-plan.md)):

| Decision                                                                                                                                          | Date          | Effect                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| Admin host `admin.sendcms.bond`, env-driven via `NEXT_PUBLIC_ADMIN_URL`                                                                           | 2026-11-21    | No hardcoded admin URL anywhere                                 |
| Staff roles: Super Admin / Manager / Support (admin app); dashboard keeps user roles only                                                         | 2026-11-21    | The role matrix in [authorization](./authorization.md)          |
| i18n: English + Urdu first, other 8 later                                                                                                         | 2026-11-21    | Proofs 10/12/13 are NOT MET — recorded honestly, not hidden     |
| BYOK: encryption, not hashing; one key per provider; platform key pauses under BYOK; Test button with every key; "Browser only" vs "Both" storage | 2026-11-21    | [ai-byok](./ai-byok.md)                                         |
| Billing providers: Stripe, PayPal, Gumroad, Freemius, Polar (in that order)                                                                       | 2026-11-21/22 | [billing-providers](./billing-providers.md)                     |
| Payments built REAL, not design-only                                                                                                              | 2026-11-22    | Supersedes the audit's "abstraction only" Phase 8 row           |
| Everything a proper page; popups only at confirmation                                                                                             | 2026-11-22    | Dashboard checkout, ticket close, provider enable — all pages   |
| Countries in a DB table; per-provider availability; IP geo detection                                                                              | 2026-11-22    | `Country` + `BillingProviderCountry`                            |
| SUPPORT does full ticket work (reply + status + assign)                                                                                           | 2026-11-22    | `requireTicketWrite`, not a capability                          |
| Code quality: professional, clean, human-written, per proper standards — database and all code                                                    | 2026-11-22    | All 39 `package.json` files re-normalized to the standard order |
| Development-phase license: anything can still change now; after final production nothing can                                                      | 2026-11-22    | Structural fixes (incl. this phase's hardening) happen now      |
| Step-up scope: irreversible + role change + MCP kill-switch                                                                                       | 2026-11-22    | [authorization](./authorization.md#step-up-re-authentication)   |
| RTL: sidebar on the right in RTL locales, left in LTR                                                                                             | 2026-11-21    | Fixed and pushed 2026-11-22; user's visual check owed           |

## Acceptance summary

Full detail: [acceptance-matrix](./acceptance-matrix.md).

| Group                                      |   PASS | PARTIAL | NOT MET |  OWED |
| ------------------------------------------ | -----: | ------: | ------: | ----: |
| The 15 proofs (additional requirements §7) |     11 |       1 |       3 |     0 |
| Per-phase rows (audit §6, phases 2–9)      |      6 |       2 |       0 |     0 |
| **Total (23 items)**                       | **17** |   **3** |   **3** | **0** |

What the numbers mean:

- **17 PASS** — proven by named tests in the 615/615 suite.
- **3 PARTIAL** — (a) locale switching persists but the
  switch-and-persist flow has no test; (b) Phase 4's
  "concurrent quota enforcement holds" is weakened by the
  documented overshoot-by-one in pre-insert quota guards;
  (c) Phase 9's "all §23 criteria hold" is not literally true
  while proofs 10/12/13 are NOT MET and live verifications are
  owed.
- **3 NOT MET** — all the same owner decision: 10 locales
  (only en + ur shipped), `ur` + `ar` RTL (only `ur` exists),
  the other 8 locales LTR (they do not exist). These stay NOT
  MET until the locales land; they are not hidden, deferred
  silently, or presented as done anywhere in these docs.
- **7 live verifications OWED** — listed in the next section.
  They are work, not proof statuses: nothing in this matrix
  claims a live result that was never observed.

## Deferred items

Explicitly deferred (spec §21 + phase records), not forgotten:

- **Real payment processing is NOT deferred anymore** — it
  shipped in Phase 8 (see above). What remains is the _live
  test_ of it.
- **Unrestricted impersonation** — not built, by design. There
  is no "sign in as user" anywhere.
- **A second auth system** — never built, by design.
- **Microservices** — no. The control plane is modules inside
  the monorepo.
- **Per-tool MCP quota** — only per-key minute/hour limits.
- **Per-ticket email notifications** — the customer is not
  emailed when staff reply (follow-up through the outbox).
- **Per-user platform-AI budgets** — beyond the plan's
  `aiRequestsPerDay` (enforced per form by the worker's daily
  cap).
- **Audit retention policy** — the log is append-only and
  nothing prunes it; how long rows are kept is undecided.
- **The other 8 locales** — `es`, `ar`, `fr`, `de`, `hi`, `bn`,
  `id`, `it`. Registry-ready, 0 files.
- **Full dashboard RTL** — shell `lang`/`dir` handling owed.
- **No AI translation** of the locale files.
- **Scheduled plan changes** — migrations are explicit and
  immediate.
- **`generateObject` → `generateText` + `output` migration**
  (AI SDK 7.x deprecation warning) — warning only, follow-up.
- **Homepage content-driven pricing section** — untouched by
  the Phase 8 pricing work.

## Open items for the owner

Work that needs the owner's machine, keys, or verdict — in
rough priority order:

1. **Push approval for Phase 9.** One commit (overview +
   rate limiting + CSP + step-up + matrix + docs). The push
   script is `~/workspace/scripts/push-sendcms.py` (branch
   `feature/admin-control-plane`); nothing is staged or
   committed by this report.
2. **Live verifications** (see
   [acceptance-matrix](./acceptance-matrix.md#live-verification-still-owed)):
   BYOK live journey (real Gemini key), MCP live client,
   Phase 7 live DB, Phase 8 billing pages + live payment test
   (real Stripe test-mode keys — test mode only), overview live
   DB check, step-up live journey, signed-in CSP nonce check.
3. **Visual checks owed:** RTL sidebar (Urdu → right,
   English → left), the `/contact` page after its production
   deploy, Phase 8 billing/support/pricing pages after pull.
4. **30-day session deploy.** Pushed (`7147d9c`) but not yet
   deployed — the owner will do it after the next tasks.
   Applies to sessions created/refreshed after deploy.
5. **Merge decision.** The `feature/admin-control-plane`
   branch (Phases 1–9) still needs a merge/PR into `main` when
   the owner says so — never without explicit approval.
6. **The dashboard `/sign-in` CSP note is CLOSED.** The gap
   the CSP pass left (sign-in outside the matcher) was fixed in
   integration: the dashboard proxy matcher now covers the five
   auth pages with a pass-through carrying the CSP header
   (`apps/dashboard/proxy.ts`). No owner action needed; recorded
   here so it is not re-raised.
