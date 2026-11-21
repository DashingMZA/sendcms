import { NextResponse, type NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import {
  PLATFORM_ROUTE_CAPABILITY,
  adminCan,
  type PlatformRole,
} from "@sendcms/permissions"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"

/**
 * Route protection for the admin app (Better Auth, database sessions).
 * - No session → the dashboard sign-in page, with a callbackURL back
 *   to the admin page that was requested. The admin app has NO sign-up
 *   page — admin accounts are owner-created (role assignment lands in
 *   Phase 3).
 * - A suspended/disabled user → the dashboard sign-in page too (their
 *   session is useless: the auth() helper also returns null for them).
 * - A signed-in user without the admin capability is sent to
 *   /admin/unauthorized. That page is explicitly allowed through here
 *   (it is the denial page itself) — without the exemption the proxy
 *   would redirect it to itself in a loop.
 * - Staff roles (Phase 3): the session carries `adminRole`, and the
 *   check passes it to `adminCan`. PLATFORM_OWNER keeps every
 *   capability; a plain customer (no adminRole) gets none.
 *
 * Session lookup hits Prisma, so this runs on the Node.js runtime (the
 * Next 16 proxy default) — it is NOT edge-safe.
 */
export default async function proxy(req: NextRequest) {
  const result = await betterAuth.api.getSession({
    headers: req.headers,
  })
  if (!result) {
    return NextResponse.redirect(
      dashboardSignInURL(`${adminBaseURL()}${req.nextUrl.pathname}`)
    )
  }

  // Suspension enforcement (Phase 3): a non-ACTIVE account cannot use
  // the admin app at all.
  if ((result.user.status ?? "ACTIVE") !== "ACTIVE") {
    return NextResponse.redirect(
      dashboardSignInURL(`${adminBaseURL()}${req.nextUrl.pathname}`)
    )
  }

  const path = req.nextUrl.pathname
  // The denial page itself: signed-in, but no capability needed to see it.
  if (path === "/admin/unauthorized") return NextResponse.next()

  const matched = Object.keys(PLATFORM_ROUTE_CAPABILITY).find(
    (route) => path === route || path.startsWith(route + "/")
  )
  if (matched) {
    const role =
      result.user.platformRole === "PLATFORM_OWNER"
        ? "PLATFORM_OWNER"
        : ((result.user.adminRole ?? "PLATFORM_USER") as
            PlatformRole | "SUPER_ADMIN" | "MANAGER" | "SUPPORT")
    if (!adminCan(role, PLATFORM_ROUTE_CAPABILITY[matched])) {
      return NextResponse.redirect(new URL("/admin/unauthorized", req.url))
    }
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/admin/:path*"],
}
