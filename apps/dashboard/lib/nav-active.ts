// The sidebar active rule (Wave 10, UX-305 — same rule as the admin
// sidebar): exactly one nav item is active per route — the LONGEST href
// that matches on a segment boundary (pathname === href, or pathname
// starts with href + "/"). Bare prefix matching over-matches:
// "/dashboard/api" is a prefix of "/dashboard/api-keys", and
// "/admin/mcp" of "/admin/mcp/keys".
export function resolveActiveHref(
  pathname: string,
  hrefs: string[]
): string | null {
  let best: string | null = null
  for (const href of hrefs) {
    const matches = pathname === href || pathname.startsWith(`${href}/`)
    if (matches && (best === null || href.length > best.length)) {
      best = href
    }
  }
  return best
}
