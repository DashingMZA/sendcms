# Admin Control Plane — Implementation Audit (Phase 1)

**Branch:** `feature/admin-control-plane` (cut from `feature/ai` @ `843ce3b`, 2026-11-21)
**Status:** Audit only. No code, schema, or deployment was changed in this phase.
**Scope:** The full Admin Control Plane brief (main prompt) + the Additional Requirements
(plan versioning, AI billing separation, centralized audit trail, admin i18n in 10 locales).
**Method:** Read-only inspection of the live repo by four parallel audits
(database, auth/permissions/security, MCP/API-keys/AI, apps/workspace/UI/deployment).
`main` and `feature/ai` were not modified.

---

## 1. What exists today (verified)

### 1.1 Apps (5)

| App | Port | Purpose |
|---|---|---|
| marketing | 3000 | Public site, pricing, demo pages (`/demo/contact-us`, `/demo/contact-us.html`) |
| api | 3001 | REST API (`/api/v1/*`), public submit (`/api/public/v1/submit`), auth (`/api/auth/*`), MCP (`POST /api/mcp`), cron (`/api/cron/email-outbox`), SDK bundle (`/forms/v1.js`) |
| dashboard | 3002 | Customer dashboard (domains, forms, inbox, notifications, analytics, API & SDK, API keys) |
| docs | 3003 | Documentation site |
| updates | 3004 | Changelog |
| email-worker (service) | 3005 | Outbox drain + AI rescore/digest poll loop (30 s) |

There is **no `apps/admin`**. There is no admin nav, admin layout, or admin-only route anywhere.

### 1.2 Packages and modules

- **Shared:** `@sendcms/config`, `@sendcms/shared`, `@sendcms/ui` (24 exports incl. `table`, `sidebar`, `dialog`, `tabs`, `badge`, `avatar`, `chart` (Recharts wrapper), `sonner`, `not-found`), `@sendcms/database`, `@sendcms/auth`, `@sendcms/permissions`, `@sendcms/security`, `@sendcms/observability`, `@sendcms/email`, `@sendcms/queue`, `@sendcms/api-client`, `@sendcms/sdk`.
- **Business modules (`packages/modules/`):** `analytics`, `api-keys`, `domains`, `forms`, `inbox`, `notifications`, `submissions`, `users` (thin — only `lookupUserByEmail` + `getUserAuthMethods`).
- **AI:** `@sendcms/ai` (Vercel AI SDK 7.0.178; 5 providers; per-form opt-in; spam rescore, digest, form-builder, reply drafts).
- **MCP:** `@sendcms/mcp` (19 tools over the same `*ForUser` services the REST routes use).

### 1.3 Database (24 migrations; latest `20261120185825_add_submission_reply`)

17 models. The ones the admin plane builds on:

- `User` (id, name, email unique, emailVerified, image, `platformRole`, createdAt/updatedAt).
  **No status/suspension field, no last-login field, no creation-source field, no index at all.**
- `Account` (Better Auth; OAuth tokens + password hash — must never be selected by admin reads).
- `Session` (token unique, expiresAt, ipAddress, userAgent; `@@index([userId])` — revocation is possible, no service exposes it).
- `Domain` (status PENDING/VERIFIED/SUSPENDED; suspension already exists at domain level).
- `Form` (`active`, `aiEnabled` default false, `dailyLimit Int?`, `lastDigestAt`).
- `Submission` (`data Json`, status, originDomain, idempotencyKey, contentHash, `aiSpamScore`/`aiScoredAt`).
- `SubmissionEvent` (append-only, actor preserved via `SetNull`).
- `EmailJob` (outbox: PENDING/SENDING/SENT/FAILED, attempts, `nextAttemptAt`, payload Json).
- `AuditLog` (append-only; action, resourceType, resourceId, detail Json, ipAddress, userId `SetNull`; indexes on `[userId, createdAt]`, `[resourceType, resourceId, createdAt]`, `[createdAt]`).
- `ApiKey` (SHA-256 `keyHash` unique, plaintext never stored, shown once; name, scope READ/FULL, prefix, last4, lastUsedAt, revokedAt timestamp-never-delete).
- `ApiKeyRateLimit` (PK = apiKeyId; DB-backed fixed-window minute/hour counters — the concurrency-safe metering pattern to copy).
- `AiDailyUsage` (one row per form per day, `@@unique([formId, date])`, calls counter — form-scoped only).

### 1.4 Auth and permissions

- **Better Auth 1.7.25** (exact pin), database sessions, **30-day expiry** (`session.expiresIn: 60*60*24*30`, `updateAge` default 1 day). Cookie domain from `COOKIE_DOMAIN` (production `sendcms.bond` — session shared across `api.` / `dashboard.` / root). Email verification 24 h; password-reset token 1 h.
- **Two roles only:** `PLATFORM_OWNER` (first registered user, auto-promoted by an atomic conditional UPDATE + partial unique index `User_single_platform_owner_idx`; `platformRole` is `additionalFields` with `input: false`, never client-settable) and `PLATFORM_USER` (everyone else). No demote/transfer/second-owner path.
- **Capability system exists but is skeletal:** `packages/permissions/src/platform.ts` — capabilities `VIEW_NOTICE_BOARD`, `VIEW_ADMINISTRATION`, `MANAGE_PLATFORM_SETTINGS` (owner has all three; user has none); `platformCan(role, cap)` is the check; `PLATFORM_ROUTE_CAPABILITY` (route → capability map) is **empty**. `platformCan` is used in exactly one place (`apps/dashboard/proxy.ts`), whose capability branch is dead code. No route checks `platformRole`; services scope by `ownerId` only.
- **Route protection pattern:** `apps/dashboard/proxy.ts` (matcher `/dashboard/:path*`; session → capability → redirect to `/sign-in`). Other apps use a no-op `proxy.ts`.
- **Audit writer:** `logAudit()` in `packages/security/src/audit.ts` — the single shared writer, best-effort (never throws). Called only from services (auth, domains, forms, inbox, api-keys). No audit reader/UI.

### 1.5 MCP and API keys

- **19 tools** (`@modelcontextprotocol/sdk` 1.32.2): domains 5, forms 5, inbox 5, analytics 2, notifications 2. READ keys see the 9 read tools; FULL keys see all 19 (registration-time gating — a READ key's client never sees mutation tools).
- **Auth:** `Authorization: Bearer <key>` → SHA-256 lookup → `{ keyId, userId, scope }` or 401. Stateless transport; POST only.
- **Rate limits:** **120/min + 2000/hour** per key (DB-backed fixed windows; only `tools/call` counted; over-limit → 429 without incrementing).
- **Keys:** `sk_live_` + 32 random bytes; max **10 active keys** per user; create requires verified email; revoke sets `revokedAt` (never deletes); rotate is one transaction (revoke old + create new, same name/scope).

### 1.6 AI (Phase 12)

- **5 providers** (platform env keys only): OpenAI `gpt-4o-mini`, Anthropic `claude-haiku-4-5`, Google `gemini-3.5-flash-lite`, DeepSeek `deepseek-chat`, OpenRouter `openai/gpt-4o-mini`. Resolution: explicit `AI_PROVIDER` wins, else auto-detect from keys in list order, else `"none"`; `AI_MODEL` overrides.
- **Per-form opt-in:** `Form.aiEnabled` (default false); capabilities 403 when off / 503 when unconfigured. Four capabilities: spam rescore, inbox digest, form-builder `suggestFields`, reply drafts `draftReply`.
- **Caps (global env, no per-user values):** spam threshold 70; daily cap 100 model calls per form per day (UTC buckets); digest interval 24 h (max 50 submissions/digest). Worker + cron route both run rescore/digest.
- **Form-builder is live-verified** on production (Gemini, 4.0 s). Reply drafts reached the outbox (2 jobs) but delivery was blocked until the daily cron was configured.

### 1.7 Deployment and operations

- **Vercel:** 5 projects (one per app), team `team_ujfcwwA1uGyddOlZxL95G83u`; production domain `sendcms.bond` with subdomains; `feature/ai` deployed to production on all 5. `BETTER_AUTH_URL=https://api.sendcms.bond` (fixed 2026-11-21); OAuth redirect URIs added and sign-in tested. `BETTER_AUTH_SECRET` must be the same value on api + dashboard (+ admin). `TRUSTED_ORIGINS` must gain the admin origin.
- **Cron:** root `vercel.json` `{"crons":[{"path":"/api/cron/email-outbox","schedule":"0 0 * * *"}]}` — daily, because Hobby allows only once/day (`*/5 * * * *` deployment failed with ERROR; daily deployment is READY). The root `vercel.json` applies to **all** Vercel projects sharing the repo root (other apps 404 on the cron path — harmless noise).
- **Cloudflare/OpenNext:** per-app `wrangler.jsonc` + `open-next.config.ts` + `build:cf`. **Docker:** parameterized `Dockerfile` (`APP` build arg) + `docker-compose.yml` — **never actually built** in the sandbox (no Docker). **Render:** `render.yaml` Blueprint (branch still pins stale `feature/monorepo-architecture-migration`). **Netlify:** per-app `netlify.toml`. **Railway:** Dockerfile via `RAILWAY_DOCKERFILE_PATH`.
- **CI:** `.github/workflows/ci.yml` triggers on `push` to `main`, `feat/**`, `feature/**` + all PRs — `feature/admin-control-plane` matches. Steps: install → `db:generate` → `sdk:build` → typecheck → lint → test → build (dummy env). Admin build must succeed with those dummy values.
- **Docs:** `docs/` holds the transformation plan, final report, `docs/mcp.md`, `docs/deployment.md`, `docs/architecture/decisions/` (ADRs 0001–0010), `docs/architecture/migration-audit.md` + `migration-final-report.md`.

---

## 2. What is missing (verified gaps)

### 2.1 No plan / subscription / entitlement system at all

Grep of schema + migration names for `plan|subscription|entitle|quota|override|billing` returns **nothing**.
No `Plan`, `PlanVersion`, `PlanFeature`, `Subscription`, `SubscriptionEvent`,
`UsageRecord`, `UsageAggregate`, `UserEntitlementOverride`, `AdminNote`,
`FeatureFlag`, `Announcement`, `UserAiSettings`, `EncryptedProviderCredential`,
`AiProviderConfiguration`, `AiModelConfiguration`, `AiUsageRecord`, and no
billing/payment models. No `packages/modules/{plans,subscriptions,entitlements,usage,ai-settings,platform-settings}`.
Plan names/limits are not hardcoded anywhere either — there is simply no plan concept.
Today **every verified-email user gets full MCP + (per-form) AI**; there is no entitlement boundary.

### 2.2 No user account status

`User` has **no status column**. Suspension, disabling, and soft-delete cannot be represented.
Only `platformRole` + `emailVerified` exist. Domain suspension exists (`DomainStatus.SUSPENDED`);
user suspension does not.

### 2.3 No admin authorization surface

- No admin capabilities beyond the two roles (`VIEW_USERS`, `MANAGE_PLANS`, `MANAGE_AI`, `MANAGE_MCP`, `VIEW_AUDIT_LOGS`, `VIEW_SENSITIVE_SUBMISSIONS`, etc. do not exist).
- No `requireCapability()` helper for API routes; routes only check "is logged in".
- No role management (assign/demote/transfer owner).
- No admin user-management service (`packages/modules/users` is only lookup + auth methods).
- No session list/revoke service for admins.

### 2.4 No usage metering ledger

Only `AiDailyUsage` (per-form daily call count, no user/provider/model/feature/token/cost)
and `ApiKeyRateLimit` (per-key fixed windows) exist. There is no user-level,
idempotency-keyed, billing-period usage ledger and no aggregates. Monthly usage today
would require scanning historical submissions — explicitly forbidden by the brief.
`Form.dailyLimit` is enforced by count-then-insert, **not** an atomic counter —
concurrent submits can overshoot the limit.

### 2.5 No BYOK / AI billing separation

- No encrypted customer credential storage; no credential model at all.
- No envelope encryption, key versioning, or rotation design.
- No model registry (defaults are hardcoded constants in `packages/ai/src/provider.ts`).
- No platform-vs-BYOK billing attribution; no `AiUsageRecord` (user/provider/model/feature/billing-mode/tokens/cost).
- No per-user/per-plan AI quotas; no provider/model availability controls; no AI error/usage reporting.
- Platform keys are env-only with no rotation story; a leaked key needs a manual env change + redeploy.
- Model deprecation is hand-edited constants (Google forced two emergency default changes in one day).

### 2.6 No MCP admin controls

No global kill-switch; no per-user MCP disable; no plan-based eligibility or tool gating;
no per-key/per-user monthly quota (only the two fixed windows); no per-tool allowlist;
no MCP usage analytics or suspicious-use alerts; no admin revoke path for another user's keys;
no key expiry; no scope narrower than READ/FULL; rate limits are hardcoded constants.

### 2.7 Audit trail gaps

`AuditLog`/`logAudit()` exist but:
- No admin-action audit (no suspension, role change, plan change, quota override, impersonation events).
- No sensitive-data access logging (no "admin viewed submission X" / reveal / export events).
- No failed-action logging (only successful operations call it).
- No reason/justification field convention (optional free-form `detail` JSON, inconsistently populated).
- No correlation/request ID, no success/failure outcome, no actor IP on most calls.
- No audit reader — no API or UI to list/search audit logs.
- `detail` is free-form JSON with **no sanitizer/redaction** — a careless caller could log a secret.
- `AuditAction`/`AuditResource` enums need extension (REVOKE, LOGIN, EXPORT, VIEW_SENSITIVE, MIGRATE, OVERRIDE; PLAN, SUBSCRIPTION, AI, MCP, FEATURE_FLAG, ANNOUNCEMENT).

### 2.8 No i18n at all

- No `packages/i18n`, no `locales/` directory, no `next-intl`/`@formatjs`/`react-intl` anywhere (0 occurrences).
- No locale routing, language selector, RTL handling, or translation files.
- The only `locale*` matches are incidental `Date.toLocaleDateString(undefined, …)` /
  `Number.toLocaleString()` calls (browser-default locale) in 4 dashboard table files.
- The required 10-locale, domain-based `packages/i18n` package must be built from scratch.
  (Note: the user's standing rule is English or Roman Urdu only in chat — the admin i18n
  requirement explicitly wants real Urdu-script translations in the product; the two are separate.)

### 2.9 No feature flags, announcements, admin notes, abuse tooling, health page, or support architecture

None of these exist. No payments/billing provider and no abstraction (must be designed, not faked).
No plan data source for the marketing pricing page (plans must not be hardcoded).

### 2.10 Security gaps relevant to an admin app

- **No CSP.** Headers are only `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`,
  `Permissions-Policy` (CSP deliberately deferred as "a separate, tested pass").
- **No rate limiting** on sign-in, password reset, verification, or any dashboard/API route
  (only MCP keys are rate-limited).
- **No re-authentication / step-up auth** for sensitive or destructive operations.
- **No CSRF middleware of its own** — relies on Better Auth's origin check; admin mutations must be reviewed against it.
- **No per-session revocation UI**; a stolen 30-day session cookie is valid until expiry or password change.
- **Best-effort audit:** `logAudit()` never throws, so a failed audit write is only logged and the request proceeds.

---

## 3. Reusable modules and patterns (do not rebuild)

| Reusable | How the admin plane uses it |
|---|---|
| `packages/auth` | Full Better Auth setup; `auth()` session helper; cross-app DB sessions; OAuth gating. Admin adds its own one-line `lib/auth.ts`. |
| `packages/permissions` | Capability-table pattern (`platformCan`, route→capability map). **Extend the enum/table, don't replace it.** |
| `packages/security` (`logAudit`, headers) | Single audit writer + header system. Extend `AuditAction`/`AuditResource` enums and the `detail` convention; do not build a second logger. |
| `apps/dashboard/proxy.ts` | Route-protection pattern (session → capability → redirect). Copy for `apps/admin/proxy.ts` with a stricter capability. |
| `apps/dashboard` shell | Sidebar + route-group layout, tables + server-side pagination, React Query `queries.ts` pattern, dialogs/toasts. Template for the admin app. |
| `packages/ui` (24 exports) | Table, sidebar, dialog, tabs, badge, avatar, `chart` (Recharts), `sonner`, `not-found`. |
| `packages/modules/{domains,forms,inbox,submissions,notifications,analytics,api-keys}` | Read-side services reusable for admin views (scoped by owner today; admin reads need an owner-scoped variant + permission check). |
| `packages/modules/api-keys` | Hash-once/rotate/revoke/audit/lastUsedAt — the template for BYOK credential metadata (minus encryption). |
| `@sendcms/ai` provider plumbing | `resolveAiProvider`/`getAiModel`/`isAiConfigured` — needs a `getAiModelForUser` variant, not a rewrite. |
| `@sendcms/mcp` tool layer | 19 tools over existing services — admin controls gate registration/resolution without touching tools. |
| `ApiKeyRateLimit` / `AiDailyUsage` | Atomic counter/upsert patterns to copy for concurrency-safe metering. |
| `Session` / `Account` models | Already carry ipAddress/userAgent and OAuth tokens for a sessions/activity view. |
| Deployment paths | Vercel (per-app project), Cloudflare/OpenNext, Docker, Render, Netlify, Railway — all additive entries. |

---

## 4. Proposed architecture

### 4.1 New app: `apps/admin` (port 3006)

- Template: **`apps/dashboard`** (the only other auth-gated, data-driven app). Copy its set verbatim and rename:
  `package.json`, `tsconfig.json`, `eslint.config.mjs`, `next.config.mjs`, `proxy.ts`,
  `app/layout.tsx`, `app/globals.css`, `app/not-found.tsx`, `styles/design-tokens.css` +
  `styles/components.css`, `config/config.json`, `public/` (+ `_headers`), `lib/auth.ts`,
  `netlify.toml`, `wrangler.jsonc`, `open-next.config.ts`.
- **No workspace/Turbo/CI registry change needed:** `pnpm-workspace.yaml` already globs
  `apps/*`; `turbo.json` tasks are generic; root scripts are generic; root `tsconfig`
  excludes `apps/`; CI triggers already match `feature/**`. The admin build must succeed
  with CI's dummy env (no build-time DB access, no extra required env).
- **Port 3006** (3000–3005 taken). `next.config.mjs` replicates the dashboard's
  `/api/v1/*` rewrite to the api app (or admin gets its own API routes under `/api/admin/*`
  on the api app — decision in Phase 2).
- **Route protection:** `apps/admin/proxy.ts`, matcher `/admin/:path*`, session → capability
  (`PLATFORM_OWNER`-only at first) → redirect. Runs on Node runtime (Prisma session lookup).
- **Vercel:** 6th project `sendcms-admin`, build `pnpm --filter @sendcms/admin build:server`,
  output `apps/admin/.next`, host `admin.sendcms.bond`. Same `BETTER_AUTH_SECRET` as api +
  dashboard; `TRUSTED_ORIGINS` gains the admin origin; new env `NEXT_PUBLIC_ADMIN_URL`
  (add to `.env.example` + `docs/deployment.md` env table).
- **Other targets:** `wrangler.jsonc` (`sendcms-admin`), `apps/admin/netlify.toml`,
  docker-compose service on 3006 (`APP=@sendcms/admin`; add `NEXT_PUBLIC_ADMIN_URL` to the
  Dockerfile `NEXT_PUBLIC_*` ARG list), Render service entry. Note: the Dockerfile has
  never been built; `render.yaml` branch is stale.

### 4.2 New business modules (framework-independent, services own the `db`)

Follow the layered flow (thin routes → services in `packages/modules/*` → only services
import `@sendcms/database`). New modules, in build order:

- `packages/modules/admin` — admin user management, account actions, session revocation,
  admin notes, platform statistics (aggregation queries only, never full-table scans).
- `packages/modules/plans` — plan + **versioned** plan CRUD, publish/archive, version
  history and comparison. Editing a plan's price/limits/AI/MCP/features creates a **new
  immutable version**; existing subscriptions stay on their original version.
- `packages/modules/subscriptions` — subscription lifecycle, plan-version attachment,
  scheduled changes, explicit migration (with preview + comparison + reason + audit),
  rollback via a new migration to a previous version (never rewrite history).
- `packages/modules/entitlements` — the single entitlement resolver with the documented
  precedence: (1) platform emergency restrictions, (2) account suspension / explicit
  denial, (3) per-user admin overrides, (4) active subscription entitlements
  (from its **effective plan version**), (5) default free-plan entitlements.
  Every business operation enforces the effective limits server-side.
- `packages/modules/usage` — idempotency-keyed usage ledger (`UsageRecord`) + aggregates
  (`UsageAggregate`); atomic increments (copy the `ApiKeyRateLimit` pattern);
  current/monthly/daily/historical usage, remaining quota, near-limit and limit-reached events.
- `packages/modules/ai-settings` — customer AI settings, BYOK credential metadata +
  envelope-encrypted storage, provider resolution (BYOK → platform → none, **no silent
  fallback**), model registry, AI usage ledger with billing-mode attribution
  (BYOK vs PLATFORM vs DISABLED), per-user/per-plan quotas.
- `packages/modules/platform-settings` — feature flags, announcements, global AI/MCP
  switches, emergency shutdown.

### 4.3 Database design (forward-only migrations; no history rewrite)

New models (proposed; final names in `docs/admin-control-plane/database-design.md`):

- `Plan`, `PlanVersion` (immutable; price/limits/AI/MCP/features snapshot), `PlanFeature`
  (typed, validated entitlement config — not unstructured JSON as the sole enforcement source).
- `Subscription`, `SubscriptionEvent` (every plan-version transition, append-only).
- `UsageRecord` (user, meter, quantity, unit, period, source event, idempotency key,
  resource id), `UsageAggregate` (pre-computed counters per user/meter/period).
- `UserEntitlementOverride` (explicit per-user admin override, with reason + expiry).
- `UserAccountStatus` — or a `status` column on `User` (suspended/disabled) + reason + actor.
  (Decision: a column is simpler; a separate table preserves history. Decide in Phase 2.)
- `AdminNote` (private, audited access).
- `FeatureFlag`, `Announcement` (+ audience/dismissal).
- `UserAiSettings` (billing mode BYOK/PLATFORM/DISABLED, provider preference, model, fallback flag).
- `EncryptedProviderCredential` (envelope-encrypted key, versioned; metadata only in clear:
  provider, label, masked value, status, last-tested, last-used).
- `AiProviderConfiguration`, `AiModelConfiguration` (registry: capabilities, context limits,
  availability, deprecation, plan allowlists).
- `AiUsageRecord` (user, provider, model, feature, billing mode, tokens when available,
  cost only when reliably available — never invent costs).
- MCP entitlement/usage config reusing existing `ApiKey`/`ApiKeyRateLimit` (add per-user
  monthly quota + tool allowlist, not a second key system).
- Extend `AuditAction` (REVOKE, LOGIN, EXPORT, VIEW_SENSITIVE, MIGRATE, OVERRIDE, …)
  and `AuditResource` (PLAN, SUBSCRIPTION, AI, MCP, FEATURE_FLAG, ANNOUNCEMENT, …).
- Extend `AuditLog` with reason, correlation ID, and outcome (success/failure) — without
  breaking the existing `logAudit()` call sites; add a sanitizer/redaction step in the writer.
- Add missing indexes: `User(createdAt)`, `User(platformRole)`, `User(emailVerified)`,
  plus per-new-table indexes on the admin list/filter columns.
- **Invariants:** user hard-delete stays destructive (Cascade) — admin "delete account" must be
  a soft/status flow, not a hard delete. `User_single_platform_owner_idx` exists only in
  migration SQL, not in `schema.prisma` — do not lose it in a re-baseline. Postgres
  `ALTER TYPE … ADD VALUE` cannot run inside a transaction block on older PG (Prisma handles it).

### 4.4 Authorization

- Extend `packages/permissions/src/platform.ts` with granular capabilities:
  `VIEW_ADMIN_DASHBOARD`, `VIEW_USERS`, `MANAGE_USERS`, `VIEW_CUSTOMER_DATA`,
  `VIEW_SENSITIVE_SUBMISSIONS`, `MANAGE_PLANS`, `MANAGE_SUBSCRIPTIONS`, `MANAGE_USAGE`,
  `MANAGE_AI`, `MANAGE_MCP`, `MANAGE_FEATURE_FLAGS`, `VIEW_AUDIT_LOGS`, `MANAGE_PLATFORM_SETTINGS`,
  `MANAGE_ADMINISTRATORS`, plus the additional set: view/publish plan versions,
  migrate subscriptions, manage AI billing/BYOK, view/export audit logs, manage translations.
- Deny by default; server-side checks on every protected route **and** in services
  (`requireCapability()` helper). The UI is never the security boundary.
- `PLATFORM_OWNER` keeps highest authority; staff roles are prepared for, not built now.
- Sensitive actions require a reason + confirmation; high-impact actions get re-authentication
  where appropriate. Admin actions are rate-limited. Sensitive-data access is logged.
- **No unrestricted impersonation** in this phase (if added later: explicit authorization,
  recorded reason, time-limited session, visible banner, full audit).

### 4.5 AI BYOK and billing separation (additional requirements §2)

- **Billing modes:** `BYOK` (customer's own provider key; provider bills the customer),
  `PLATFORM` (SendCMS-managed credentials; consumes the platform-funded allowance),
  `DISABLED`. The mode is validated against the effective plan + admin permissions.
- **Hard rules:** BYOK usage never consumes platform credits; platform usage is never
  attributed to BYOK; a failed/expired BYOK key returns a clear error and never silently
  falls back to platform billing (fallback only when the user explicitly enables it);
  a customer's key is never sent to a different provider; keys are envelope-encrypted at rest
  (master key outside the DB), versioned, never in responses/logs/analytics/audit records.
- **Provider resolution (single strategy):** valid BYOK config (when BYOK enabled and plan
  permits) → platform AI (when plan allows) → no AI. Explicit user preference respected.
- **Usage attribution** is stored separately from access permissions (provider, model,
  billing mode, user, feature, tokens when available, cost only when reliably available).

### 4.6 Centralized audit trail (additional requirements §3)

- Extend `logAudit()`/`AuditLog` (do not build a second logger): administrator identity,
  target user/resource, action, resource type + ID, previous/new state where safe,
  timestamp, reason, request correlation ID, IP/device metadata (subject to privacy/retention),
  success/failure.
- Cover: suspension/reactivation, deletion/recovery, role/permission changes, plan create/edit/
  publish/migration, subscription changes, quota/entitlement overrides, AI permission and
  billing-mode changes, BYOK credential changes (**without recording credentials**), MCP
  permission/scope/revocation, API-key create/revoke, feature-flag changes, platform/security
  settings, sensitive-data access, submission reveal/export.
- Admins cannot silently edit/delete historical records (append-only shape is already there;
  enforce it — no update/delete path). Audit records never contain passwords, tokens, keys,
  secrets, or raw submission content. Idempotency/correlation IDs prevent duplicates.
- Admin audit explorer with filters (administrator, user, action, resource, date, status)
  and safe export, gated by dedicated permissions.

### 4.7 Admin i18n — mandatory, from the start (additional requirements §4)

- **There is no i18n infrastructure today; it must be built from scratch.**
- New reusable package `packages/i18n`: locale registry + metadata, domain-based loading,
  typed keys where feasible, interpolation/pluralization, locale-aware formatting,
  RTL/LTR utilities, missing-key detection, validation scripts.
- **Exactly 10 locales initially:** `en` (LTR), `ur` (RTL), `es` (LTR), `ar` (RTL),
  `fr` (LTR), `de` (LTR), `hi` (LTR), `bn` (LTR), `id` (LTR), `it` (LTR). Extensible for more.
- **Domain-based JSON files — never one large file per locale:**
  `packages/i18n/locales/{locale}/{domain}.json`, e.g. `actions`, `admins`, `appearance`,
  `auth`, `common`, `confirmations`, `dashboard`, `empty-states`, `errors`, `forms`,
  `language`, `navigation`, `notifications`, `pagination`, `profile`, `security`,
  `settings`, `tables`, `users`, `validation`, plus `plans`, `subscriptions`, `billing`,
  `usage`, `ai`, `mcp`, `domains`, `submissions`, `api-keys`, `audit`, `system`,
  `integrations`, `feature-flags`, `announcements`, `analytics`, `activity`, `support`
  (as actually needed — do not create unused domains).
- **Quality rules:** `en` is the source; real translations for all 10 (never copy English as
  placeholder); preserve placeholders/plurals/formatting; consistent terminology; correct
  native scripts (Urdu in Urdu script, Hindi in Devanagari, Bengali in Bengali script,
  Arabic in Arabic script); technical identifiers/provider names unchanged; no hardcoded
  user-facing strings in components/pages/forms/dialogs/validation/navigation/notifications/tables;
  translate accessible labels, tooltips, loading/empty/error/confirmation/success states.
- **RTL:** `dir="rtl"` automatically for `ur`/`ar`; logical CSS properties (not hardcoded
  left/right); sidebars, tables, dialogs, forms, charts, pagination verified in RTL;
  do not mirror every icon (preserve directional meaning); locale-aware date/time/number/
  currency/percentage formatting; language persists via the established user-preference
  mechanism; language selector in the Admin UI; English fallback.
- **Validation:** scripts to check JSON syntax, matching keys across locales, missing
  translations, and unused keys; missing keys are detected automatically — never silently
  fall back to displaying translation keys in production.
- **Translation management (admin):** view supported languages + completion status, missing/
  outdated keys by domain, export for external review, validate before acceptance.
  No ordinary admin may overwrite translation files from an unrestricted browser operation;
  changes follow a secure, version-controlled workflow. Optional AI translation is
  permission-controlled, reviewable, and separate from product AI entitlements; never
  auto-publish unreviewed translations.

---

## 5. Risks

1. **Scope is very large.** 9 phases + 4 additional requirement areas. The biggest risks
   are (a) building UI before the backend contracts exist, (b) plan/entitlement logic leaking
   into page components instead of services, and (c) i18n translation volume (10 locales ×
   ~20+ domains) dwarfing the feature work if done naively. Mitigation: strict phase order
   (schema + entitlements + usage before admin UI; i18n package + English first, then locales
   per domain as pages land).
2. **Entitlement enforcement must be server-side everywhere.** The submit path, MCP endpoint,
   and AI calls must enforce limits without depending on the admin app or on billing-provider
   availability. The core submission path must stay independent of AI, billing, and admin
   availability (per §21 of the brief).
3. **BYOK encryption is the highest-risk new subsystem.** Envelope encryption, master-key
   handling, rotation, and "never expose" guarantees need a dedicated design review before code.
   Do not store a customer key even once in plaintext, including in tests or seed data.
4. **Plan versioning changes the entitlement model.** Every entitlement check and usage
   calculation must use the subscription's *effective plan version*, not the plan's current
   version. A single missed call site silently changes existing customers' terms.
5. **Audit integrity.** `logAudit()` is best-effort today; the admin trail needs reliable writes
   for sensitive actions. Decide per-action whether a failed audit write must fail the request.
   Free-form `detail` JSON must gain a sanitizer so secrets can never be logged.
6. **Hobby-plan deployment limits.** Vercel Hobby allows cron only once/day; the admin app adds
   a 6th project and lengthens sequential CI builds. The root `vercel.json` cron will also fire
   on the admin project (404 noise).
7. **No CSP + no admin rate limiting + no step-up auth** — all deferred security work that an
   admin app handling sensitive data should not ship without. At minimum, do the CSP pass and
   admin-action rate limiting before the admin app goes to production.
8. **User hard-delete cascades are destructive.** Admin "delete account" must be a soft/status
   flow; a hard delete wipes domains, forms, submissions, API keys, and AI usage.
9. **Translation quality at scale.** 10 locales × many domains is a large, error-prone surface.
   Machine-translated placeholders that break interpolation or change a provider/model name are
   real defects. Validation scripts + a review workflow are mandatory, not optional.
10. **The `generateObject` deprecation** (AI SDK 7.x) is still open; the admin AI work should not
    depend on it, but the migration remains a follow-up.

---

## 6. Implementation sequence (phases, per the brief §20 + additional requirements)

| Phase | Scope | Acceptance (abridged) |
|---|---|---|
| 1 — Audit (this document) | Inspect, audit report, architecture, plan | This document; branch created; no code changed |
| 2 — Admin app + authorization | `apps/admin` (port 3006), workspace/Turbo/CI wiring, `lib/auth.ts`, `proxy.ts`, capability extension, admin shell + nav, `packages/i18n` skeleton + English domains | Admin app builds; non-owner gets denied; owner can sign in; English strings render via the i18n package |
| 3 — Overview + user management | Platform stats (aggregation only), users table/detail, forms/domains/submissions inspection, account actions (suspend/reactivate), audit history, `User.status` | Real stats; admin can inspect a user end-to-end; suspension works and is audited |
| 4 — Plans + entitlements | Plan + **versioned** plan CRUD, publish/archive, migration workflow with preview, `Subscription` + `SubscriptionEvent`, per-user overrides, **server-side enforcement** in forms/domains/submit/API-keys, usage metering ledger + aggregates | Editing a plan creates a new version and does not alter existing subscriptions; a direct API call cannot bypass a limit; concurrent quota enforcement holds |
| 5 — AI provider + BYOK | Envelope encryption, credential metadata, customer `/dashboard/ai` settings (backend first), provider resolution (BYOK → platform → none, no silent fallback), model registry, AI usage ledger with billing-mode attribution, admin AI controls | BYOK usage never charged to platform; failed BYOK key never silently falls back; keys never appear in responses/logs |
| 6 — MCP controls | Global/per-user/plan MCP gating, tool allowlists, per-key monthly quotas, usage analytics, admin revoke | Disabled MCP is enforced by the MCP service, not just the UI; revoked keys stay revoked |
| 7 — Platform operations | Feature flags, audit explorer, abuse controls, health dashboard, announcements, admin notes, support architecture | Flags/announcements work end-to-end; audit explorer filters + exports |
| 8 — Marketing + customer integration | Public pricing data/projection from plan records, customer entitlement + usage summary APIs, billing-provider abstraction (design only — no fake payments) | Pricing page reads plan records; no duplicated prices/limits in frontend constants |
| 9 — Hardening + verification | Security/tenant-isolation/quota-concurrency/AI-secret/MCP-permission tests, build all apps, typecheck, lint, full regression, docs | All acceptance criteria in brief §23 hold; docs accurate about implemented vs deferred |

**i18n runs across phases 2–9, not as a final phase:** the package + English domains land in Phase 2;
each new admin page ships with its domain files in all 10 locales; validation scripts run in CI.
Translation management UI lands in Phase 7.

**Deferred (explicitly, per brief §21):** real payment processing (Stripe/Paddle) — abstraction only;
unrestricted impersonation (not in this phase); a second auth system (never); microservices (no);
redesigning the customer dashboard or marketing site beyond the pricing-data integration.

---

## 7. Decisions needed from the owner (before Phase 2)

1. **Confirm Phase 1 → Phase 2 go-ahead** (or adjust scope/order).
2. **Admin host:** `admin.sendcms.bond` (suggested) — confirm, or choose another subdomain.
3. **BYOK master key:** where the envelope-encryption master key lives (Vercel env on the api
   project is the natural place; confirm — it must never be committed or pasted in chat).
4. **Billing provider (future):** Stripe vs Paddle vs undecided — needed only for the Phase 8
   abstraction shape; no integration work starts now.
5. **Staff roles:** owner-only for now (recommended), or name the first staff capability set.
6. **i18n priority:** English + Urdu first, then the other 8 locales as pages land — or all 10
   from the first admin page (slower start, fuller coverage).
