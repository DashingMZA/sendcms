// Shared admin authorization (Phase 16, Wave 2 — SRC-215 / SRC-411):
// the single home for `requireAdmin` / `getEffectiveRole`. Six modules
// used to carry byte-identical copies of this gate (admin-users,
// ai-settings, mcp-admin, plans, support, platform-ops) plus a
// same-body alias in billing (`requireBillingAdmin`); a future role
// change applied to five of them would silently leave one module
// enforcing the old rule. Every module now imports this file and
// re-exports it for compatibility — there is one implementation.
//
// The actor type is structural on purpose: the permissions package
// must stay free of the auth package (which itself depends on
// permissions — importing it here would be a cycle), and every
// `AdminSession` is assignable to `AdminActor` because it carries
// the same two role fields. `adminCan` denies unknown roles
// (fail closed, SRC-307), so a corrupt role string reads as
// "no capability", never a 500.
import { ApiError } from "@sendcms/shared"
import {
  adminCan,
  type AdminRole,
  type PlatformCapability,
  type PlatformRole,
} from "./platform"

/** The actor shape the admin gate needs: only the two role fields. */
export type AdminActor = {
  user: {
    platformRole?: PlatformRole | null
    adminRole?: AdminRole | null
  }
}

// The actor's effective role: the platform owner outranks everything,
// a staff adminRole comes next, and everyone else is a plain user.
export function getEffectiveRole(
  session: AdminActor
): PlatformRole | AdminRole {
  if (session.user.platformRole === "PLATFORM_OWNER") return "PLATFORM_OWNER"
  return session.user.adminRole ?? "PLATFORM_USER"
}

// Throws 403 unless the actor holds the capability.
export function requireAdmin(
  session: AdminActor,
  capability: PlatformCapability
): void {
  if (!adminCan(getEffectiveRole(session), capability)) {
    throw new ApiError(
      "Forbidden: you do not have permission for this admin action.",
      403
    )
  }
}
