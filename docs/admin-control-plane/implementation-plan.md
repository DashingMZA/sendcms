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

### Phase 3 — Admin overview & user management — PENDING

`User.status` (suspend/disable), `User.adminRole`, user list + detail
(tabs per spec §5), admin actions (suspend/reactivate, role change, plan
assign, quota adjust, revoke keys/sessions, notes, export, deletion
requests), sensitive-data masking + access logging.

### Phase 4 — Plans & entitlements — PENDING

Versioned plans (immutable versions; edits create a new version),
subscriptions, entitlements, usage metering ledger, server-side
enforcement on every relevant operation, precedence per spec §7.

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
