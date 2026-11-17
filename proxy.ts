import { NextResponse, type NextRequest } from "next/server"
import { betterAuth } from "@/lib/auth"
import {
  PLATFORM_ROUTE_CAPABILITY,
  platformCan,
  type PlatformRole,
} from "@/lib/permissions"

/**
 * Route protection (Better Auth, database sessions).
 * - No session → /sign-in.
 * - Logged-in users without the platform capability for a route are sent
 *   to /dashboard (same behaviour as the old Auth.js `authorized` check).
 *
 * Session lookup hits Prisma, so this runs on the Node.js runtime (the
 * Next 16 proxy default) — it is NOT edge-safe.
 */
export default async function proxy(req: NextRequest) {
  const result = await betterAuth.api.getSession({
    headers: req.headers,
  })
  if (!result) {
    const url = req.nextUrl.clone()
    url.pathname = "/sign-in"
    return NextResponse.redirect(url)
  }

  const path = req.nextUrl.pathname
  const matched = Object.keys(PLATFORM_ROUTE_CAPABILITY).find(
    (route) => path === route || path.startsWith(route + "/")
  )
  if (matched) {
    const role = (result.user.platformRole ?? "PLATFORM_USER") as PlatformRole
    if (!platformCan(role, PLATFORM_ROUTE_CAPABILITY[matched])) {
      return NextResponse.redirect(new URL("/dashboard", req.url))
    }
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/dashboard/:path*"],
}
