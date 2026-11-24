// lib/permissions/platform.ts
// SINGLE SOURCE OF TRUTH for instance-level (platform) authorization rules.
// Dependency-free (no Next.js, no Prisma client) so it is safe to import from
// edge middleware, Node services, and client components alike.

export type PlatformRole = "PLATFORM_OWNER" | "PLATFORM_USER"

export type PlatformCapability =
  | "VIEW_NOTICE_BOARD"
  | "VIEW_ADMINISTRATION"
  | "MANAGE_PLATFORM_SETTINGS"
  // Admin Control Plane (Phase 2) — the admin app's capabilities.
  | "VIEW_ADMIN_DASHBOARD"
  | "VIEW_USERS"
  | "MANAGE_USERS"
  | "VIEW_CUSTOMER_DATA"
  | "VIEW_SENSITIVE_SUBMISSIONS"
  | "MANAGE_PLANS"
  | "MANAGE_SUBSCRIPTIONS"
  | "MANAGE_USAGE"
  | "MANAGE_AI"
  | "MANAGE_MCP"
  | "VIEW_MCP"
  | "MANAGE_FEATURE_FLAGS"
  | "VIEW_AUDIT_LOGS"
  // MANAGE_PLATFORM_SETTINGS is already in the legacy set above.
  | "MANAGE_ADMINISTRATORS"
  | "VIEW_PLAN_VERSIONS"
  | "PUBLISH_PLAN_VERSIONS"
  | "MIGRATE_SUBSCRIPTIONS"
  | "MANAGE_AI_BILLING"
  | "MANAGE_BYOK"
  | "VIEW_AI_USAGE"
  | "EXPORT_AUDIT_LOGS"
  | "MANAGE_TRANSLATIONS"
  | "REVIEW_TRANSLATIONS"
  // Admin Control Plane (Phase 7) — platform announcements.
  | "MANAGE_ANNOUNCEMENTS"
  // Admin Control Plane (Phase 8) — billing providers + payments.
  | "VIEW_BILLING"
  | "MANAGE_BILLING"

const PLATFORM_PERMISSIONS: Record<
  PlatformRole,
  readonly PlatformCapability[]
> = {
  PLATFORM_OWNER: [
    "VIEW_NOTICE_BOARD",
    "VIEW_ADMINISTRATION",
    "MANAGE_PLATFORM_SETTINGS",
    "VIEW_ADMIN_DASHBOARD",
    "VIEW_USERS",
    "MANAGE_USERS",
    "VIEW_CUSTOMER_DATA",
    "VIEW_SENSITIVE_SUBMISSIONS",
    "MANAGE_PLANS",
    "MANAGE_SUBSCRIPTIONS",
    "MANAGE_USAGE",
    "MANAGE_AI",
    "MANAGE_MCP",
    "VIEW_MCP",
    "MANAGE_FEATURE_FLAGS",
    "VIEW_AUDIT_LOGS",
    "MANAGE_ADMINISTRATORS",
    "VIEW_PLAN_VERSIONS",
    "PUBLISH_PLAN_VERSIONS",
    "MIGRATE_SUBSCRIPTIONS",
    "MANAGE_AI_BILLING",
    "MANAGE_BYOK",
    "VIEW_AI_USAGE",
    "EXPORT_AUDIT_LOGS",
    "MANAGE_TRANSLATIONS",
    "REVIEW_TRANSLATIONS",
    "MANAGE_ANNOUNCEMENTS",
    "VIEW_BILLING",
    "MANAGE_BILLING",
  ],
  PLATFORM_USER: [],
}

export const platformCan = (
  role: PlatformRole,
  cap: PlatformCapability
): boolean => (PLATFORM_PERMISSIONS[role] ?? []).includes(cap)

// --- Admin staff roles (Admin Control Plane, Phase 2) -----------------------
// The platform owner stays the highest authority (every capability).
// Staff roles are the admin app's roles; the owner assigns them in Phase 3.
//
// NOTE: the `User.adminRole` database field does NOT exist yet (it lands in
// Phase 3 with the role-assignment UI). Until then the admin proxy can only
// enforce PLATFORM_OWNER — staff-role enforcement activates in Phase 3
// when the field exists and the session carries it.
export type AdminRole = "SUPER_ADMIN" | "MANAGER" | "SUPPORT"

// The admin capabilities (everything except the three legacy
// notice-board-era capabilities, which stay owner-only).
const ADMIN_CAPABILITIES: readonly PlatformCapability[] = [
  "VIEW_ADMIN_DASHBOARD",
  "VIEW_USERS",
  "MANAGE_USERS",
  "VIEW_CUSTOMER_DATA",
  "VIEW_SENSITIVE_SUBMISSIONS",
  "MANAGE_PLANS",
  "MANAGE_SUBSCRIPTIONS",
  "MANAGE_USAGE",
  "MANAGE_AI",
  "MANAGE_MCP",
  "VIEW_MCP",
  "MANAGE_FEATURE_FLAGS",
  "VIEW_AUDIT_LOGS",
  "MANAGE_ADMINISTRATORS",
  "VIEW_PLAN_VERSIONS",
  "PUBLISH_PLAN_VERSIONS",
  "MIGRATE_SUBSCRIPTIONS",
  "MANAGE_AI_BILLING",
  "MANAGE_BYOK",
  "VIEW_AI_USAGE",
  "EXPORT_AUDIT_LOGS",
  "MANAGE_TRANSLATIONS",
  "REVIEW_TRANSLATIONS",
  // Admin Control Plane (Phase 7) — platform announcements.
  "MANAGE_ANNOUNCEMENTS",
  // Admin Control Plane (Phase 8) — billing providers + payments.
  "VIEW_BILLING",
  "MANAGE_BILLING",
]

export const ADMIN_ROLE_CAPABILITIES: Record<
  AdminRole,
  readonly PlatformCapability[]
> = {
  // Full admin access except managing administrators (owner-only).
  SUPER_ADMIN: ADMIN_CAPABILITIES.filter((c) => c !== "MANAGE_ADMINISTRATORS"),
  // Limited rules: view + manage users and subscriptions, inspect plans
  // and usage, read audit logs and AI usage. No plan/AI/MCP publishing,
  // no feature flags, no translations, no administrator management.
  // MANAGE_USERS here excludes role changes — that sub-restriction is
  // enforced in the Phase 3 user-management service, not here.
  MANAGER: [
    "VIEW_ADMIN_DASHBOARD",
    "VIEW_USERS",
    "MANAGE_USERS",
    "VIEW_CUSTOMER_DATA",
    "VIEW_SENSITIVE_SUBMISSIONS",
    "VIEW_PLAN_VERSIONS",
    "MANAGE_SUBSCRIPTIONS",
    "MANAGE_USAGE",
    "VIEW_AUDIT_LOGS",
    "VIEW_AI_USAGE",
    "VIEW_MCP",
    "VIEW_BILLING",
  ],
  // Support queries only: view users and their data, nothing else.
  SUPPORT: [
    "VIEW_ADMIN_DASHBOARD",
    "VIEW_USERS",
    "VIEW_CUSTOMER_DATA",
    "VIEW_SENSITIVE_SUBMISSIONS",
    "VIEW_MCP",
  ],
}

// Capability check for the admin app. Accepts either a platform role or a
// staff admin role: the platform owner has every capability, a plain
// platform user has none, and staff roles get their mapped set.
export const adminCan = (
  role: PlatformRole | AdminRole,
  cap: PlatformCapability
): boolean => {
  if (role === "PLATFORM_OWNER") return true
  if (role === "PLATFORM_USER") return false
  // Unknown role: deny (fail closed) instead of throwing on the
  // record lookup — a corrupt or future role string in the DB must
  // read as "no capability", never a 500 (SRC-307).
  return (ADMIN_ROLE_CAPABILITIES[role] ?? []).includes(cap)
}

// Platform routes gated by capability — consumed by proxy.ts
// (apps/admin/proxy.ts; the dashboard proxy reads the same map and
// finds no /dashboard entry, so it is unaffected).
//
// One entry per admin page family (Phase 16, Wave 2 — SEC-102): the
// capability is the READ capability the page's data needs, so a staff
// member outside it is redirected to /admin/unauthorized before the
// page's server fetch can 500. Write mutations stay gated by their own
// API routes (SRC-105) — the proxy only decides whether the page
// shell may load. The longest matching prefix wins (the proxy sorts
// by length), so "/admin/ai/providers" beats "/admin/ai" beats
// "/admin". Every entry must stay in sync with the page's data
// source; tests/permissions.test.ts pins the whole map.
export const PLATFORM_ROUTE_CAPABILITY: Record<string, PlatformCapability> = {
  "/admin": "VIEW_ADMIN_DASHBOARD",
  "/admin/ai": "VIEW_AI_USAGE",
  "/admin/ai/models": "VIEW_AI_USAGE",
  "/admin/ai/providers": "MANAGE_AI",
  "/admin/ai/settings": "MANAGE_AI",
  "/admin/ai/usage": "VIEW_AI_USAGE",
  "/admin/announcements": "MANAGE_ANNOUNCEMENTS",
  "/admin/audit-logs": "VIEW_AUDIT_LOGS",
  "/admin/billing": "VIEW_BILLING",
  "/admin/features": "MANAGE_FEATURE_FLAGS",
  "/admin/health": "VIEW_ADMIN_DASHBOARD",
  "/admin/mcp": "VIEW_MCP",
  "/admin/mcp/keys": "VIEW_MCP",
  "/admin/plans": "VIEW_PLAN_VERSIONS",
  "/admin/security": "MANAGE_USERS",
  "/admin/settings": "VIEW_ADMIN_DASHBOARD",
  "/admin/submissions": "VIEW_CUSTOMER_DATA",
  "/admin/subscriptions": "VIEW_USERS",
  "/admin/subscriptions/migrate": "MIGRATE_SUBSCRIPTIONS",
  "/admin/support": "VIEW_CUSTOMER_DATA",
  "/admin/translations": "MANAGE_TRANSLATIONS",
  "/admin/usage": "MANAGE_USAGE",
  "/admin/users": "VIEW_USERS",
}
