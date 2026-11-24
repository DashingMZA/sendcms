import { redirect } from "next/navigation"
import { auth } from "./auth"
import type { AdminSession } from "@sendcms/auth"

// Requires a signed-in dashboard session (Phase 16, Wave 2 —
// SRC-102 / SEC-011). Dashboard pages used to dereference
// `session!.user!` on the assumption that the proxy had already
// gated the request; if the proxy matcher ever misses a route (or
// the page renders outside the proxy path) that throws a 500
// instead of a redirect. Every dashboard server page calls this
// first and uses the returned session — never `session!`.
export async function requireDashboardSession(): Promise<AdminSession> {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")
  return session
}
