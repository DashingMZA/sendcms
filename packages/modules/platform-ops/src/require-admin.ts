import type { AdminSession } from "@sendcms/auth"
import { db } from "@sendcms/database"
import type { AdminRole, PlatformRole } from "@sendcms/database"
import { adminCan, type PlatformCapability } from "@sendcms/permissions"
import { ApiError } from "@sendcms/shared"

// Shared admin authorization for the platform-ops module (same shape
// as the mcp-admin / admin-users modules): the actor's effective role
// is the platform owner first, then the staff adminRole, then a plain
// user. Every service function takes the actor's AdminSession first
// and enforces its capability HERE — the routes never decide access.
export function getEffectiveRole(
  session: AdminSession
): PlatformRole | AdminRole {
  if (session.user.platformRole === "PLATFORM_OWNER") return "PLATFORM_OWNER"
  return session.user.adminRole ?? "PLATFORM_USER"
}

// Throws 403 unless the actor holds the capability.
export function requireAdmin(
  session: AdminSession,
  capability: PlatformCapability
): void {
  if (!adminCan(getEffectiveRole(session), capability)) {
    throw new ApiError(
      "Forbidden: you do not have permission for this admin action.",
      403
    )
  }
}

export async function getTargetUserOrThrow(userId: string) {
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  })
  if (!target) throw new ApiError("User not found.", 404)
  return target
}

// Every mutating route generates one correlationId per request and
// passes it here; the audit writer uses it as the idempotency key
// (same correlationId + action + resource = one row, never two).
export type AuditOpts = {
  correlationId?: string
}
