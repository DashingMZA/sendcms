# Plans & Entitlements (Phase 4)

Versioned plans, subscriptions, a single entitlement resolver, an
idempotency-keyed usage ledger, per-user overrides, and server-side
enforcement in the existing services — without changing any existing
user's behaviour. The default Free plan (version 1) mirrors today's
hardcoded limits exactly (API keys 10, AI 100 calls/day, MCP 120/min +
2000/hour, everything else unlimited), so creating it changes nothing
for current users; limits are admin-configurable from here on.

Branch: `feature/admin-control-plane` (pushed, not merged to
`main`, not deployed).

## Contents

- [Plan versioning](#plan-versioning)
- [Entitlements](#entitlements)
- [Entitlement resolution — precedence](#entitlement-resolution--precedence)
- [The emergency flag](#the-emergency-flag)
- [Subscriptions](#subscriptions)
- [Usage metering](#usage-metering)
- [Enforcement points (server-side, fail-open)](#enforcement-points-server-side-fail-open)
- [Behaviour change: AI rescore cap value is now per owner, not global](#behaviour-change-ai-rescore-cap-value-is-now-per-owner-not-global)
- [Audit](#audit)
- [Capabilities](#capabilities)
- [What is NOT built (deferred)](#what-is-not-built-deferred)
- [Known limitations](#known-limitations)

Module: `packages/modules/plans` (`@sendcms/plans`).
Routes: `apps/api/app/api/v1/admin/plans/*`, `.../subscriptions/*`,
`.../usage`, `.../users/[userId]/subscription`,
`.../users/[userId]/overrides/*`. The version lifecycle is
documented in full in [plan-versioning](./plan-versioning.md);
how "used" is computed per meter is in
[usage-metering](./usage-metering.md).

## Plan versioning

- `Plan` — name, slug (unique), kind FREE/PAID, `isPrivate` (private
  plans are invisible to public pricing and can only be assigned by an
  admin), status DRAFT/PUBLISHED/ARCHIVED, `currentVersionId`.
- `PlanVersion` — one immutable snapshot of price + entitlements.
  `version` increments per plan (1, 2, 3…). A DRAFT version is never
  published in place twice; a PUBLISHED version is **never mutated**.
- Editing a plan's price, limits, AI or MCP config creates a **new
  DRAFT version** (`createPlanVersion`). Publishing it
  (`publishPlanVersion`, reason required) sets it as the plan's
  current version and SUPERSEDES the previously published one.
  Existing subscriptions keep pointing at their original version —
  their terms are never rewritten by a plan edit.
- `duplicatePlan` copies the current version's entitlements into a
  new plan as version 1 DRAFT. `archivePlan` retires the plan and its
  draft/published versions and clears `currentVersionId`; existing
  subscriptions on its versions keep working.
- `comparePlanVersions` returns a field-level before/after diff
  (price, billing interval, trial days, every entitlement key) used by
  the admin UI's version comparison and by the migration preview.

## Entitlements

`PlanEntitlementsSchema` (Zod, strict) is the single source of truth
for the `PlanVersion.entitlements` JSON — validated at write time and
parsed at read time. A stored version that fails validation is corrupt
data and fails loudly (500), never silently enforced wrong.

| Key                                          | Meaning                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `forms`, `domains`, `submissionsPerMonth`    | `number` limit, or `null` = unlimited                                                                                              |
| `apiKeys`                                    | always a `number` (an unbounded key count is an abuse vector)                                                                      |
| `aiRequestsPerDay`                           | `number`, or `null` = unlimited                                                                                                    |
| `mcpRequestsPerMinute`, `mcpRequestsPerHour` | `number`, or `null` = "use the platform default" (the MCP constants 120/2000) — an un-rate-limited MCP endpoint is an abuse vector |
| `aiProviders`                                | allowlist subset of openai / anthropic / google / deepseek / openrouter                                                            |
| `aiByokAllowed`, `aiPlatformAllowed`         | whether the plan permits BYOK / platform AI                                                                                        |
| `features`                                   | free-form feature flags (strings)                                                                                                  |

## Entitlement resolution — precedence

`getEffectiveEntitlements(userId)` returns
`{ entitlements, source, planVersionId, denied?, emergency, overriddenMeters }`:

1. **Platform emergency** — `platform.emergency` in the workspace-root
   `config/config.json` (see below). When on, AI + MCP are zeroed for
   everyone. Forms, domains and submissions are never restricted by
   this flag.
2. **Suspension** — a non-ACTIVE user gets `entitlements: null` +
   `denied: "suspended"`.
3. **Per-user overrides** — non-expired `EntitlementOverride` rows
   (one per meter, `value` null = unlimited, reason required, audited).
   Applied on top of the base entitlements; `source` becomes
   `"override"` and `overriddenMeters` lists them. API_KEYS and
   MCP_REQUESTS overrides cannot be null (rejected with 400).
4. **Active subscription** — the subscription's **effective plan
   version** entitlements (never the plan's current version).
5. **Default Free plan** — `ensureDefaultFreePlan()` creates the Free
   plan (slug `free`, published version 1) when none exists, idempotent
   under concurrency (unique-slug P2002 → re-read). If the admin
   deliberately archived the Free plan, the resolver falls back to the
   in-memory `FREE_PLAN_V1_ENTITLEMENTS` instead of resurrecting it.
   Never throws for a missing plan; 404 only for an unknown user.

The full precedence chain, with the per-meter "used" computation,
is in [usage-metering](./usage-metering.md).

### The emergency flag

`config/config.json` at the workspace root (the repo's feature-flag
file — per AGENTS.md, all new config goes there, not `.env`):

```json
{ "platform": { "emergency": false } }
```

Read by `readPlatformConfig()` in the plans service: it walks up from
`process.cwd()` to the workspace root (the directory holding
`pnpm-workspace.yaml`), reads the file, and caches the result per
process (`resetPlatformConfigCache()` for tests). A missing file, bad
JSON, or missing key all mean "no emergency". This is the ONLY source
for the flag — no env var, no second file. (There was no root
`config/config.json` and no runtime config loader before this phase;
the per-app `config/config.json` files hold branding/metadata only.)

## Subscriptions

- `Subscription` — userId, planId, **planVersionId (the effective
  version)**, status ACTIVE/TRIALING/PAST_DUE/CANCELED/EXPIRED,
  period start/end, `cancelAtPeriodEnd`. One ACTIVE subscription per
  user, enforced in the service (assign cancels the old one before
  creating the new one) — a DB partial unique index is not
  expressible in Prisma schema.
- `assignSubscription` — in ONE transaction: cancel any existing
  active subscription (CANCELED event) and create the new one
  (CREATED event). The target version must be PUBLISHED. Audited
  (ASSIGN).
- `getMigrationPreview` — which subscriptions a migration to a
  PUBLISHED version would touch: either the listed users' active
  subscriptions or every active subscription on a given version. Each
  affected user gets a before/after comparison (price + limits +
  features + AI + MCP). Users already on the target version (or with
  no active subscription) are listed in `skippedUserIds`, never
  touched. The preview shows the first 100 users
  (`previewTruncated` says whether more exist).
- `executeMigration` — applies the migration to EXACTLY the selected
  userIds. Each subscription's version change + its MIGRATED event
  happen in one transaction, so a version change is never recorded
  without its event. Unselected subscriptions are never touched.
  Rollback is a new migration back to a previous version — history is
  never rewritten.
- `SubscriptionEvent` — append-only history (CREATED / MIGRATED /
  RENEWED / CANCELED / EXPIRED / REACTIVATED) with from/to versions,
  admin, reason.
- `cancelSubscription` — immediate cancel (status CANCELED + event)
  or `cancelAtPeriodEnd` (stays ACTIVE with the flag set; the actual
  expiry is a later job's concern). Audited (CANCEL).

## Usage metering

- `UsageLedger` — append-only: userId, meter, quantity, unit, period
  (bucket start: month start / day start / hour start, UTC), source
  event, **idempotencyKey (@unique)**, resourceId. `recordUsage`
  returns the existing row on an idempotency-key conflict instead of
  double-counting. `getUsage` sums quantities for a user + meter in
  one bucket.
- `checkLimit(userId, meter)` — `{ allowed, limit, used, remaining }`
  from the effective entitlements + the current period. How `used` is
  computed per meter:
  - FORMS / DOMAINS / API_KEYS — the **live count** (never the ledger).
  - SUBMISSIONS — the Submission table in the current calendar month
    (never the ledger — the ledger is a reporting record).
  - AI_REQUESTS — the AiDailyUsage counters summed across the user's
    forms for today (UTC).
  - MCP_REQUESTS — the current-hour ApiKeyRateLimit counters summed
    across the user's keys (the per-minute limit is enforced per key
    in the MCP limiter).
- `consumeQuota` — check + record in one step; when over the limit
  nothing is recorded and `allowed` is false.

## Enforcement points (server-side, fail-open)

Every enforcement point wraps the entitlement check so a plans-module
error never breaks the core path — the check returns null and the
operation proceeds with the platform default:

| Operation                              | Limit                     | Behaviour                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form create (`@sendcms/forms`)         | FORMS                     | 409 only when the limit is a number and the live count reaches it                                                                                                                                                 |
| Domain register (`@sendcms/domains`)   | DOMAINS                   | same pattern                                                                                                                                                                                                      |
| API key create (`@sendcms/api-keys`)   | API_KEYS                  | replaces the hardcoded `MAX_ACTIVE_API_KEYS = 10` (kept as the fallback default)                                                                                                                                  |
| MCP `tools/call` (`@sendcms/mcp`)      | mcpRequestsPerMinute/Hour | per-key-owner entitlements; constants stay as defaults when the entitlement is null or the lookup fails — see [mcp-management](./mcp-management.md#quota-precedence)                                              |
| AI rescore (`@sendcms/submissions`)    | aiRequestsPerDay          | the cap **value** now comes from the form owner's effective plan (was the global env default for every form); the per-form daily usage counter (AiDailyUsage) is unchanged; env default 100 when the lookup fails |
| Public submit (`@sendcms/submissions`) | SUBMISSIONS (monthly)     | 402 only when the submission quota itself is exhausted; on accept, one UsageLedger row (idempotencyKey = submission id). IP rate limits are anti-abuse, not entitlements — untouched                              |

**Never silently drop submissions:** a submission is rejected only
when the submission quota itself is exhausted. An AI limit, a billing
failure, or a plans-module error never blocks the submit path (the
check is fail-open and the ledger write is best-effort).

### Behaviour change: AI rescore cap value is now per owner, not global

Before Phase 4 the rescore cap was the global env default (100) for
every form. It is now the form **owner's** `aiRequestsPerDay` from
their effective plan (env default 100 when the lookup fails). The
per-form daily usage counter (`AiDailyUsage`, keyed by form + day) is
unchanged — a multi-form owner still gets the same cap applied per
form, and the admin-facing `checkLimit` for AI_REQUESTS sums usage
across the owner's forms. A suspended owner gets a cap of 0 (skipped).

## Audit

Every mutation writes an AuditLog row via `logAudit` (best-effort):
plan create / version create / publish / archive / duplicate (PLAN),
subscription assign / migrate / cancel (SUBSCRIPTION), override set /
remove (ENTITLEMENT). Reasons are recorded in `detail` for publish,
migrate, assign, and overrides. No secrets are ever logged. The
writer is documented in
[admin-audit-trail](./admin-audit-trail.md).

## Capabilities

Reads: `VIEW_PLAN_VERSIONS` (plans), `VIEW_USERS` (subscription
list), `VIEW_CUSTOMER_DATA` (subscription detail, user subscription).
Mutations: `MANAGE_PLANS` (create / version / archive / duplicate),
`PUBLISH_PLAN_VERSIONS` (publish), `MANAGE_SUBSCRIPTIONS` (assign /
cancel), `MIGRATE_SUBSCRIPTIONS` (preview / execute),
`MANAGE_USAGE` (overrides, usage reads). All enforced in the service
via `requireAdmin`; the admin UI's hiding is UX only. Full matrix:
see [authorization](./authorization.md).

## What is NOT built (deferred)

- **No scheduled plan changes** (a dated "switch this plan on X"
  feature) — the migration workflow is explicit and immediate.
- **No UsageAggregate table.** Aggregates are computed on read from
  the ledger / live counts; the ledger is indexed for the admin's
  query patterns (`[userId, meter, period]`,
  `[userId, meter, createdAt]`).

📌 Note — two Phase 4 statements are superseded by Phase 8
(2026-11-22):

- **Payments are real now.** The deferred item that called the
  billing-provider abstraction (PayPal, Stripe, Gumroad, Freemius,
  Polar.sh) "Phase 8 — design only, no fake payments" is superseded
  by the owner's decision to build payments real. See
  [billing-providers](./billing-providers.md).
- **The public pricing route exists now.** Marketing pricing reads
  the same plan records via `GET /api/public/v1/plans` and the
  `/pricing` page renders every published plan live — see
  [billing-providers](./billing-providers.md#public-plans--pricing-page).
  Subscriptions are still admin-assigned or webhook-activated; there
  is no self-serve plan change outside checkout.

## Known limitations

- The quota guards are pre-insert checks (count, then create), not
  serializable transactions — two concurrent creates at the exact
  limit can overshoot by one. This matches the codebase's existing
  pattern; the ledger provides the audit trail. A strict guarantee
  would need a DB-level counter per meter. The same pattern applies
  to the MCP quota guards — see
  [mcp-management](./mcp-management.md#known-limitations).
- `checkLimit` for MCP_REQUESTS reports the hourly aggregate only;
  the per-minute limit is enforced per key inside the MCP limiter.
- The emergency flag is cached per process; changing
  `config/config.json` needs a server restart to take effect.
