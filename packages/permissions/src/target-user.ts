// Shared admin target lookup (Phase 16, Wave 2 — SRC-411): the one
// `getTargetUserOrThrow`. Three modules carried their own copy
// (platform-ops, admin-users, mcp-admin) with different selects;
// this is the superset of the fields any caller needs (the guards
// need `platformRole`, the mailers need `email`, the detail views
// need `name`).
//
// This lives in its own subpath entry (`@sendcms/permissions/target-user`)
// instead of the package root on purpose: it imports `@sendcms/database`,
// and the root entry must stay dependency-free so the proxies and the
// client components can keep importing `platformCan` / `adminCan`
// without pulling the Prisma client into an edge or browser bundle.
import { db } from "@sendcms/database"
import { ApiError } from "@sendcms/shared"

// The target user for an admin action, with the fields the guards need.
export async function getTargetUserOrThrow(userId: string) {
  const target = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      platformRole: true,
      adminRole: true,
      status: true,
    },
  })
  if (!target) throw new ApiError("User not found", 404)
  return target
}
