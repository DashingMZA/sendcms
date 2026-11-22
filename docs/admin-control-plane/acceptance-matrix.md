# Acceptance matrix (Admin Control Plane, Phase 9)

Every acceptance item for the Admin Control Plane, verified
against the code and the test suite — not against the plan's
claims. Status per item: **PASS** (proven by a named test or
by code the tests exercise), **PARTIAL** (built but with a
named gap), **NOT MET** (specified but not built, with the
reason), **OWED** (needs a live check the sandbox cannot do).
Nothing is marked PASS that is only mocked, untested, or
deferred.

The suite behind this matrix: **615/615 tests, 46 files**
(`pnpm test`, 2026-11-22), root typecheck 0. Every test cited
below passes in that run.

## Contents

- [Status summary](#status-summary)
- [Part A — the 15 proofs (additional requirements §7)](#part-a--the-15-proofs-additional-requirements-7)
- [Part B — per-phase acceptance (audit §6, phases 2–9)](#part-b--per-phase-acceptance-audit-6-phases-29)
- [Live verification still owed](#live-verification-still-owed)
- [Superseded decisions](#superseded-decisions)

## Status summary

| Group                               |   PASS | PARTIAL | NOT MET |  OWED |
| ----------------------------------- | -----: | ------: | ------: | ----: |
| The 15 proofs (Part A)              |     11 |       1 |       3 |     0 |
| Per-phase rows (Part B, phases 2–9) |      6 |       2 |       0 |     0 |
| **Total (23 items)**                | **17** |   **3** |   **3** | **0** |

The 3 NOT MET items are all the same decision: the owner chose
English + Urdu first (2026-11-21) and the other 8 locales
later. The 3 PARTIAL items each name their gap below. The 7
live verifications are listed separately — they are not proof
statuses, they are work still owed on the owner's machine.

## Part A — the 15 proofs (additional requirements §7)

| #   | Proof                                                                                | Status  | Evidence                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Plan edit creates a new version; existing subscriptions' terms unchanged             | PASS    | `tests/plans.test.ts` — "creates a new DRAFT version and leaves the published version untouched" (:323); "uses the subscription's effective version, not the plan's current one" (:832)                                                          |
| 2   | A migration touches only the selected subscriptions                                  | PASS    | `tests/plans.test.ts` — "updates ONLY the selected subscriptions" (:680); "skips users already on the target version" (:728)                                                                                                                     |
| 3   | Historical records (old plan versions, subscription events, usage) remain accessible | PASS    | `tests/plans.test.ts` — "keeps historical versions and subscription events readable" (:790); `SubscriptionEvent` + `UsageLedger` are append-only, never deleted                                                                                  |
| 4   | BYOK usage is never charged to the platform                                          | PASS    | `tests/ai-byok.test.ts` (41 tests) — "uses the BYOK key first when the mode is BYOK" (:826); `getAiUsageSummary` returns BYOK and PLATFORM totals separately, never mixed                                                                        |
| 5   | Platform usage is attributed to the platform                                         | PASS    | `tests/ai-byok.test.ts` — "uses the platform key when the mode is PLATFORM" (:841); `AiUsageRecord.billingMode` is set per call from the resolver's return                                                                                       |
| 6   | A failed BYOK key never silently falls back to the platform key                      | PASS    | `tests/ai-byok.test.ts` — "records a FAILED test and never falls back to the platform key" (:679); "throws when BYOK is selected but no key is saved — never falls back to platform" (:853)                                                      |
| 7   | Critical actions are audited                                                         | PASS    | `tests/platform-ops.test.ts` (31 tests) + `tests/plans.test.ts` + `tests/support.test.ts` + `tests/billing.test.ts` — flag toggles, deletion review/erasure, migration, ticket status/assign, provider changes all write audit rows with reasons |
| 8   | The audit trail is immutable (no edit/delete via admin interfaces)                   | PASS    | `tests/platform-ops.test.ts` — "exports no AuditLog mutation (immutability proof)" (:1421); the module has no update/delete function and no route for either                                                                                     |
| 9   | No sensitive values in audit records or logs                                         | PASS    | `tests/ai-byok.test.ts` — "lists metadata only — never key material" (:608); services never write secrets into `detail` (see note below)                                                                                                         |
| 10  | 10 locales with matching keys                                                        | NOT MET | Only `en` + `ur` are complete (41 files each, 100% in sync). The other 8 locales have 0 files — owner decision 2026-11-21, English + Urdu first                                                                                                  |
| 11  | Missing keys are detected by validation                                              | PASS    | `pnpm --filter @sendcms/i18n validate` (run 2026-11-22: "en and ur are complete and in sync"; the 8 coming-soon locales report "not started"); `tests/platform-ops.test.ts` — "detects missing keys per locale and domain" (:1786)               |
| 12  | `ur` + `ar` render RTL                                                               | NOT MET | `ur` RTL is built (`dir="rtl"`, sidebar right — `apps/admin/app/layout.tsx`, `apps/admin/components/admin/app-sidebar.tsx:217`). `ar` has no files at all, so no Arabic RTL exists to verify                                                     |
| 13  | The other 8 locales render LTR                                                       | NOT MET | The 8 locales do not exist (0 files each). Nothing renders, LTR or otherwise                                                                                                                                                                     |
| 14  | Locale switching works and persists (browser + database)                             | PARTIAL | The mechanism exists — `sendcms-locale` cookie (1-year) + `User.locale` + `POST /api/v1/users/me/locale` — but no test exercises the switch-and-persist flow itself (see note below)                                                             |
| 15  | Existing systems (submit path, inbox, MCP, AI) still operate                         | PASS    | Full suite green (615/615): submit, inbox, MCP server, and AI capability tests all pass unchanged. Live operation is separately OWED (below)                                                                                                     |

### Notes on three proofs

- **Proof 6, the one deliberate fallback.** `resolveAiModelForUser`
  has exactly one fallback, and it is not a key fallback: when
  the _settings store itself_ is unreadable, the mode cannot be
  known, so the platform default is used (`resolveAiModelLegacy`).
  Once the mode is known to be BYOK, a missing, disabled, or
  failing key **never** falls back — the tests above prove it.
  See [ai-byok](./ai-byok.md#provider-resolution).
- **Proof 9, the limit of the proof.** The unit tests prove
  services return metadata only and never put key material in
  responses; the code review proves `detail` never carries
  secrets. No production log review has been done — there is no
  production log to review yet (the control plane is not
  deployed). A live log scan belongs to the first production
  review, not to this matrix.
- **Proof 14, why PARTIAL and not PASS.** The persistence
  pieces are each proven somewhere — `User.locale` is written
  and read (`tests/admin-users.test.ts:264,298` asserts a user
  detail returns `locale: "ur"`; `tests/platform-ops.test.ts:1673`
  asserts erasure nulls it) — but no test drives the
  switch-and-persist flow end to end (detect → prompt → cookie
  and DB write → next visit shows the stored language). The code
  path is short and the pieces are covered; the flow itself is
  untested, so it is PARTIAL, not PASS. One limit to record:
  the DB copy is the durable record, not the live source —
  nothing in the admin layout reads `User.locale` on load, so
  the cookie decides the language and the stored preference
  does not yet follow the user across devices.

## Part B — per-phase acceptance (audit §6, phases 2–9)

Each row is the abridged acceptance from
`implementation-audit.md` §6, verified the same way as Part A.

| Phase                                | Acceptance (abridged)                                                                                                                                       | Status  | Evidence / note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 — Admin app + authorization        | Admin app builds; non-owner gets denied; owner can sign in; English strings render via the i18n package                                                     | PASS    | Admin + dashboard + api builds pass; `apps/admin/proxy.ts` gates on `VIEW_ADMIN_DASHBOARD`; `tests/permissions.test.ts` proves the owner/staff/plain-user maps; en strings render through `createTranslator`                                                                                                                                                                                                                                                                                                                                            |
| 3 — Overview + user management       | Real stats; admin can inspect a user end-to-end; suspension works and is audited                                                                            | PASS    | **With a timing note:** the "real stats" half only landed in Phase 9 — the Phase 3 overview was the honest Phase 2 shell. As of now the overview is real (`tests/admin-overview.test.ts`, 17 tests) and user inspection + suspension are proven by `tests/admin-users.test.ts`                                                                                                                                                                                                                                                                          |
| 4 — Plans + entitlements             | Editing a plan creates a new version and does not alter existing subscriptions; a direct API call cannot bypass a limit; concurrent quota enforcement holds | PARTIAL | The first two hold (proofs 1–2 above). **"Concurrent quota enforcement holds" does not fully hold:** the quota guards are pre-insert checks, so two concurrent creates at the exact limit can overshoot by one (documented in [plans-and-entitlements](./plans-and-entitlements.md#known-limitations)). The ledger is the audit trail for the overshoot                                                                                                                                                                                                 |
| 5 — AI provider + BYOK               | BYOK usage never charged to platform; failed BYOK key never silently falls back; keys never appear in responses/logs                                        | PASS    | Proofs 4, 5, 6, 9 above; `tests/ai-byok.test.ts` (41 tests). Live verification OWED (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6 — MCP controls                     | Disabled MCP is enforced by the MCP service, not just the UI; revoked keys stay revoked                                                                     | PASS    | `tests/mcp-admin.test.ts` (52 tests): kill-switch 503, suspended-owner 403, allowlist 404, revoke delegates to `@sendcms/api-keys` and is audited. Live verification OWED (below)                                                                                                                                                                                                                                                                                                                                                                       |
| 7 — Platform operations              | Flags/announcements work end-to-end; audit explorer filters + exports                                                                                       | PASS    | `tests/platform-ops.test.ts` (31 tests): flag precedence, announcement window + audience, explorer filters, export, deletion state machine, erasure. Live verification OWED (below)                                                                                                                                                                                                                                                                                                                                                                     |
| 8 — Marketing + customer integration | Pricing page reads plan records; no duplicated prices/limits in frontend constants                                                                          | PASS    | **With a supersession note (below):** the audit row says "billing-provider abstraction (design only — no fake payments)". The owner decided 2026-11-22 to build payments REAL. What shipped: `GET /api/public/v1/plans` + marketing `/pricing` reading live records (no hardcoded prices), real Stripe/PayPal/Polar/Freemius checkout + Gumroad registered-only (`tests/billing.test.ts`, 21 tests), tickets (`tests/support.test.ts`, 19 tests). Live payment test OWED (below)                                                                        |
| 9 — Hardening + verification         | All acceptance criteria in brief §23 hold; docs accurate about implemented vs deferred                                                                      | PARTIAL | CSP enforcing (`tests/security.test.ts`, 12 tests, "ships enforcing"), admin-API + auth rate limiting (`tests/admin-rate-limit.test.ts`, 18 tests; 78/78 admin routes wired), step-up (`tests/step-up.test.ts`, 21 tests), real overview (`tests/admin-overview.test.ts`, 17 tests), and this matrix + the docs it cites. **§23 does not literally all hold:** proofs 10/12/13 are NOT MET by owner decision, and the live verifications below are OWED. The second half holds — these docs say plainly what is implemented, partial, not met, and owed |

## Live verification still owed

Everything in this matrix is proven by unit tests against
mocked databases and services — that is what the sandbox can
do. The following need a real database, a real browser, or
real provider keys, all on the owner's machine:

| #   | What                                      | Needs                                                                                                                                                                     |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phase 5 BYOK live journey                 | Real Gemini key + real BYOK save/test/resolve on the dev DB                                                                                                               |
| 2   | Phase 6 MCP live client                   | A real MCP client against the dev DB                                                                                                                                      |
| 3   | Phase 7 live DB                           | The platform-ops flows against the real dev DB (all proofs mocked)                                                                                                        |
| 4   | Phase 8 billing pages + live payment test | Pull + visual check of `/admin/billing`, `/dashboard/billing`, `/pricing`; real Stripe test-mode keys for a test checkout (test mode only — no real money)                |
| 5   | Overview live DB check                    | Pull + open `/admin` against the real dev DB; confirm the numbers match the database                                                                                      |
| 6   | Step-up live journey                      | Sign in as admin, run a step-up action (e.g. disable a user in a test account), confirm the password dialog and the 10-minute window                                      |
| 7   | Signed-in dashboard/admin CSP nonce check | Sign in and confirm document nonces match on signed-in pages (the dev verification covered unauthenticated paths only — the session lookup short-circuits with no cookie) |

Also owed from earlier phases (not part of this matrix, kept
here so they are not lost): the user's visual check of the
RTL sidebar (Urdu → right, English → left), the `/contact`
page after its production deploy, and the 30-day session
deploy (pushed, not yet deployed — owner will do it after the
next tasks).

## Superseded decisions

Two audit-time statements are stale and are recorded here so
the matrix is not misread. **The audit doc itself is not
edited** (it is the Phase 1 historical record).

1. **Phase 8, "billing-provider abstraction (design only)".**
   Superseded by the owner's decision of 2026-11-22: payments
   are built REAL (Stripe, PayPal, Polar, Freemius checkout +
   webhooks; Gumroad registered-only because it has no
   payment-creation API). See
   [billing-providers](./billing-providers.md).
2. **"10 locales with matching keys" (proof 10).** Superseded
   in scope — not in the spec — by the owner's decision of
   2026-11-21: English + Urdu first, the other 8 later. The
   proof stays NOT MET until the locales land; the decision is
   recorded in [implementation-plan](./implementation-plan.md)
   and [internationalization](./internationalization.md).
