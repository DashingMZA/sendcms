# AI Billing & Access (Phase 5)

One billing mode per user decides whose key pays for each AI call:
the customer's own key (BYOK), the platform key, or no AI at all.
The mode is validated against the user's effective plan
entitlements at set time and re-checked at resolution time, and
every model call is recorded with its attribution — BYOK usage
never consumes platform credits and platform usage is never
attributed to BYOK.

Branch: `feature/admin-control-plane` (pushed, not merged to
`main`, not deployed). Live verification against a real provider
is still owed.

## Contents

- [Billing modes](#billing-modes)
- [Plan validation](#plan-validation)
- [Attribution (BYOK vs platform, never mixed)](#attribution-byok-vs-platform-never-mixed)
- [Admin controls](#admin-controls)
- [What AI limits never do](#what-ai-limits-never-do)
- [Deferred (not in this phase)](#deferred-not-in-this-phase)

## Billing modes

One mode per user, stored in `UserAiSettings` (default PLATFORM when
no row exists). The mode is validated against the user's EFFECTIVE
plan entitlements (`getEffectiveEntitlements` — the same precedence
as Phase 4: emergency → suspension → override → subscription →
Free, see [usage-metering](./usage-metering.md)) at set time, and
re-checked at resolution time.

| Mode       | Meaning                                                                                                    | Requires                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `BYOK`     | Use my own keys where I have them. The platform key is PAUSED for this user until they re-enable PLATFORM. | Plan `aiByokAllowed`                                                              |
| `PLATFORM` | Use the system's `.env` key.                                                                               | Plan `aiPlatformAllowed`                                                          |
| `DISABLED` | No AI for this user.                                                                                       | Nothing (always allowed, even for a suspended account — an admin may want AI off) |

- BYOK means "use my keys where I have them" — for a provider with
  NO stored BYOK key there is NO silent platform fallback.
  Resolution throws a clear error instead, and the caller degrades
  to the non-AI behavior. See the resolution flow in
  [ai-byok](./ai-byok.md#provider-resolution).
- A suspended user cannot enable AI (BYOK/PLATFORM are refused
  with 403; DISABLED is still allowed).
- Setting a mode is audited (UPDATE on USER,
  `detail.event: "ai-billing-mode-changed"`, with the previous mode).
  The admin version (`setUserAiBillingModeForAdmin`, MANAGE_AI)
  applies the same validation to another user.

Module: `packages/modules/ai-settings` (`@sendcms/ai-settings`).
Entitlements: `packages/modules/plans` (`@sendcms/plans`,
`getEffectiveEntitlements` / `getEffectiveEntitlementsSafe`).
Routes: `apps/api/app/api/v1/ai/billing-mode`,
`.../admin/ai/usage/*`, `.../admin/ai/users/[userId]/billing-mode`.
Tests: `tests/ai-byok.test.ts` (41 tests, shared with
[ai-byok](./ai-byok.md)).

## Plan validation

- `aiByokAllowed` / `aiPlatformAllowed` come from the effective
  entitlements, not from the request. The UI is never the security
  boundary: a client-supplied mode or provider is validated
  server-side on every call.
- The plan's `aiProviders` allowlist applies to BOTH paths: a
  provider the plan forbids can neither be saved as a BYOK key nor
  resolved on the platform path.
- The admin's per-provider config (`AiProviderConfig.isEnabled`,
  `allowedModels`, `defaultModel`) gates the PLATFORM path and the
  BYOK path alike (a provider the admin disabled is off for
  everyone); `allowedModels` only constrains which models the
  platform key may call.
- The Phase 4 emergency flag (`config/config.json`
  `platform.emergency`) zeroes AI for everyone: the effective
  entitlements report `aiByokAllowed`/`aiPlatformAllowed` false, so
  resolution throws "AI is temporarily disabled by the platform
  administrator." The emergency switch never disables form
  submission, the inbox, or any non-AI service. (A per-request
  browser-only key is the user's own key spent on their own
  account, so it is not blocked by the platform switch.)

## Attribution (BYOK vs platform, never mixed)

Every model call records an `AiUsageRecord`:

- `userId`, `provider`, `model`, `billingMode` (BYOK / PLATFORM),
  `tokensIn` / `tokensOut` when the provider reports them,
  `costMicros` (micro-dollars) ONLY when the provider reports a
  reliable cost — never an estimate, never a price-table lookup —
  `status` (SUCCESS / FAILED / RETRY), `sourceEvent` (the purpose:
  `spam-rescore`, `digest`, `suggest-fields`, `draft-reply`,
  `key-test`), `resourceId` (form/submission id).
- Recording is best-effort (`recordAiUsage` never throws): a failed
  usage write must not break the capability that made the call.
- Token counts come from the SDK's reported usage, surfaced through
  the `onUsage` callback the four capability functions gained in
  `packages/ai` (`toAiCallUsage` normalizes the AI SDK 7
  `inputTokens`/`outputTokens` shape). A provider that reports no
  usage records the call with null tokens.
- BYOK usage NEVER consumes platform credits; platform usage is
  NEVER attributed to BYOK. The summary endpoint
  (`getAiUsageSummary`) returns BYOK and PLATFORM totals separately
  — calls, success/failed, tokens, cost — plus a total. They are
  never mixed.
- `listAiUsage` filters by user / provider / billingMode / status /
  sourceEvent / date, paginated. `getProviderHealth` reports the
  last-24h error rate per provider from the same records (counts
  only).

## Admin controls

- **Global provider config** (`/admin/ai/providers`, MANAGE_AI):
  enable/disable each provider, set the model allowlist and the
  default model for the platform key. Missing rows are auto-created
  with defaults on first read.
- **Provider health** (`/admin/ai/providers/health`, MANAGE_AI):
  enabled?, platform key configured?, last-24h calls/failed/error
  rate.
- **Usage reporting** (`/admin/ai/usage`, `/admin/ai/usage/summary`,
  VIEW_AI_USAGE): filtered lists + the BYOK-vs-platform summary.
- **Per-user controls** (MANAGE_AI): view a user's key metadata
  (`listUserAiKeysForAdmin` — metadata only), set a user's billing
  mode (`setUserAiBillingModeForAdmin`).
- **Emergency disable:** the Phase 4 emergency flag
  (`config/config.json`, `platform.emergency`) stops all AI
  (BYOK + platform). It needs a restart to take effect (config is
  read once and cached by `@sendcms/plans`).
- **Audit:** every billing-mode change, provider-config change, and
  BYOK key change is audited (see [ai-byok](./ai-byok.md) for the
  event list). Audit records never contain key material,
  tokens, or submission content.

## What AI limits never do

- AI limits NEVER block form submissions. The submission path is
  independent of AI availability, billing-provider availability,
  and admin availability. Only the submission quota itself (Phase 4) can reject a submission, with a 402.
- A failed BYOK key NEVER silently switches the user to the
  platform key. The user sees a clear error and decides (fix the
  key, switch to PLATFORM, or disable AI).
- A BYOK key is NEVER sent to a different provider (bound by the
  crypto AAD and by the lookup).

## Deferred (not in this phase)

- No payments or billing provider: there is no charging, no
  invoicing, and no price-table cost estimation. Real payments
  arrived later in Phase 8 — see
  [billing-providers](./billing-providers.md); entitlement logic
  stays provider-agnostic.
- No per-user platform-AI budgets/quotas beyond the plan's
  `aiRequestsPerDay` (enforced per form by the worker's daily cap).
  Per-user platform budgets are a follow-up.
- No cost reporting beyond provider-reported costs (see above).

📌 Note: the Phase 5 text originally said no admin or dashboard AI
UI existed yet. That is superseded — the follow-up UI shipped:
`/admin/ai/*` (overview, providers, settings, usage, models) and
`/dashboard/ai` (billing mode, per-provider cards, storage popup,
Test button). See
[implementation-report](./implementation-report.md#phase-5--ai-provider--byok-2026-11-21).
