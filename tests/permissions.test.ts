import { describe, expect, it } from "vitest"
import {
  ADMIN_ROLE_CAPABILITIES,
  PLATFORM_ROUTE_CAPABILITY,
  adminCan,
  platformCan,
  type AdminRole,
  type PlatformCapability,
  type PlatformRole,
} from "@sendcms/permissions"

const ALL_CAPABILITIES: PlatformCapability[] = [
  "VIEW_NOTICE_BOARD",
  "VIEW_ADMINISTRATION",
  "MANAGE_PLATFORM_SETTINGS",
  // Admin Control Plane (Phase 2)
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
  // Admin Control Plane (Phase 7)
  "MANAGE_ANNOUNCEMENTS",
  // Admin Control Plane (Phase 8)
  "VIEW_BILLING",
  "MANAGE_BILLING",
  // Seven Admin Pages, Phase C — Jobs (plan §3.6, Q9)
  "VIEW_JOBS",
  "MANAGE_JOBS",
]

describe("platformCan", () => {
  it("gates the admin app and no customer dashboard route", () => {
    // The comment system's routes were removed, so no /dashboard route is
    // gated. The admin app (Phase 2) is the only gated route.
    // Phase 16, Wave 2 — SEC-102: one entry per admin page family,
    // so the proxy can deny before the page fetches anything
    // (SUPPORT → /admin/plans is a 307 to /admin/unauthorized, not
    // a page that half-loads then 500s). The proxy matches the
    // LONGEST prefix, so /admin/subscriptions/migrate wins over
    // /admin/subscriptions.
    expect(PLATFORM_ROUTE_CAPABILITY).toEqual({
      "/admin": "VIEW_ADMIN_DASHBOARD",
      "/admin/activity": "VIEW_AUDIT_LOGS",
      "/admin/ai": "VIEW_AI_USAGE",
      "/admin/ai/models": "VIEW_AI_USAGE",
      "/admin/ai/providers": "MANAGE_AI",
      "/admin/ai/settings": "MANAGE_AI",
      "/admin/ai/usage": "VIEW_AI_USAGE",
      "/admin/all-users": "VIEW_USERS",
      "/admin/announcements": "MANAGE_ANNOUNCEMENTS",
      "/admin/audit-logs": "VIEW_AUDIT_LOGS",
      "/admin/billing": "VIEW_BILLING",
      "/admin/features": "MANAGE_FEATURE_FLAGS",
      "/admin/health": "VIEW_ADMIN_DASHBOARD",
      "/admin/jobs": "VIEW_JOBS",
      "/admin/mcp": "VIEW_MCP",
      "/admin/mcp/keys": "VIEW_MCP",
      "/admin/payments": "VIEW_BILLING",
      "/admin/plans": "VIEW_PLAN_VERSIONS",
      "/admin/plans-subscriptions": "VIEW_USERS",
      "/admin/security": "MANAGE_USERS",
      "/admin/settings": "VIEW_ADMIN_DASHBOARD",
      "/admin/submissions": "VIEW_CUSTOMER_DATA",
      "/admin/subscriptions": "VIEW_USERS",
      "/admin/subscriptions/migrate": "MIGRATE_SUBSCRIPTIONS",
      "/admin/support": "VIEW_CUSTOMER_DATA",
      "/admin/translations": "MANAGE_TRANSLATIONS",
      "/admin/trials": "VIEW_USERS",
      "/admin/usage": "MANAGE_USAGE",
    })
  })

  it("grants the owner every platform capability", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(platformCan("PLATFORM_OWNER", cap)).toBe(true)
  })

  it("grants a plain platform user no platform capability", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(platformCan("PLATFORM_USER", cap)).toBe(false)
  })

  it("denies an unknown role instead of throwing (SRC-307)", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(platformCan("BOGUS" as PlatformRole, cap)).toBe(false)
  })
})

describe("adminCan", () => {
  it("grants the platform owner every capability", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(adminCan("PLATFORM_OWNER", cap)).toBe(true)
  })

  it("grants a plain platform user no capability", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(adminCan("PLATFORM_USER", cap)).toBe(false)
  })

  it("grants SUPER_ADMIN every admin capability except managing administrators", () => {
    const expected = ALL_CAPABILITIES.filter(
      (c) =>
        c !== "VIEW_NOTICE_BOARD" &&
        c !== "VIEW_ADMINISTRATION" &&
        c !== "MANAGE_PLATFORM_SETTINGS" &&
        c !== "MANAGE_ADMINISTRATORS"
    )
    expect([...ADMIN_ROLE_CAPABILITIES.SUPER_ADMIN].sort()).toEqual(
      [...expected].sort()
    )
    for (const cap of expected) expect(adminCan("SUPER_ADMIN", cap)).toBe(true)
    expect(adminCan("SUPER_ADMIN", "MANAGE_ADMINISTRATORS")).toBe(false)
  })

  it("grants MANAGER only the limited rule set", () => {
    const expected: PlatformCapability[] = [
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
      "VIEW_JOBS",
    ]
    expect([...ADMIN_ROLE_CAPABILITIES.MANAGER].sort()).toEqual(
      [...expected].sort()
    )
    expect(adminCan("MANAGER", "MANAGE_PLANS")).toBe(false)
    expect(adminCan("MANAGER", "MANAGE_AI")).toBe(false)
    expect(adminCan("MANAGER", "MANAGE_ADMINISTRATORS")).toBe(false)
    expect(adminCan("MANAGER", "MANAGE_JOBS")).toBe(false)
  })

  it("grants SUPPORT view-only support capabilities", () => {
    const expected: PlatformCapability[] = [
      "VIEW_ADMIN_DASHBOARD",
      "VIEW_USERS",
      "VIEW_CUSTOMER_DATA",
      "VIEW_SENSITIVE_SUBMISSIONS",
      "VIEW_MCP",
      "VIEW_JOBS",
    ]
    expect([...ADMIN_ROLE_CAPABILITIES.SUPPORT].sort()).toEqual(
      [...expected].sort()
    )
    expect(adminCan("SUPPORT", "MANAGE_USERS")).toBe(false)
    expect(adminCan("SUPPORT", "VIEW_AUDIT_LOGS")).toBe(false)
    expect(adminCan("SUPPORT", "MANAGE_JOBS")).toBe(false)
  })

  it("denies an unknown role instead of throwing (SRC-307)", () => {
    for (const cap of ALL_CAPABILITIES)
      expect(adminCan("BOGUS" as AdminRole, cap)).toBe(false)
  })

  it("covers every admin role in the capability map", () => {
    const roles: AdminRole[] = ["SUPER_ADMIN", "MANAGER", "SUPPORT"]
    for (const role of roles)
      expect(ADMIN_ROLE_CAPABILITIES[role].length).toBeGreaterThan(0)
  })
})
