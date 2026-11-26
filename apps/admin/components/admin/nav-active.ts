// Admin sidebar active-state rule (Wave 10, UX-002 / UX-305).
//
// Prefix matching (`pathname.startsWith(href)`) marked both a parent
// and its child active at once (e.g. "MCP" + "MCP keys" on
// /admin/mcp/keys, "AI" + "Providers" on /admin/ai/providers). The
// rule is: a href matches on a segment boundary, and when several
// match, only the longest (most specific) one is active — exactly one
// active item on every route.
export function isActiveNavHref(href: string, pathname: string): boolean {
  if (href === "/admin") return pathname === "/admin"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function getActiveNavHref(
  hrefs: readonly string[],
  pathname: string
): string | undefined {
  let best: string | undefined
  for (const href of hrefs) {
    if (
      isActiveNavHref(href, pathname) &&
      (best === undefined || href.length > best.length)
    ) {
      best = href
    }
  }
  return best
}
