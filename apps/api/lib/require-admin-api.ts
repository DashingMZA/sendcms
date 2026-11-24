import { auth } from "@/lib/auth"
import type { AdminSession } from "@sendcms/auth"
import { ApiError } from "@sendcms/api-client"
import { requireAdmin, type PlatformCapability } from "@sendcms/permissions"

// Route-level admin gate (Phase 16, Wave 2 — SRC-105): defense in
// depth for the admin API. Every `/api/v1/admin/*` handler calls this
// first; it authenticates the session (401 when signed out) and then
// asserts the capability for that route (403 when the actor lacks it)
// BEFORE the service is called. The service keeps its own
// `requireAdmin` check as the second layer, so a service that forgot
// its check can no longer fail open — and a route test can catch a
// missing gate without a database.
//
// The capability passed here is always the one the route's service
// function enforces (see the per-route map in
// `tests/admin-route-capabilities.test.ts`); where a service admits
// exactly one role set under a different name, the route uses the
// capability whose holders are that same set, and the map test pins
// the equivalence.
export async function requireAdminApi(
  capability: PlatformCapability
): Promise<AdminSession> {
  const session = await auth()
  if (!session?.user?.id) throw new ApiError("Unauthorized", 401)
  requireAdmin(session, capability)
  return session
}
