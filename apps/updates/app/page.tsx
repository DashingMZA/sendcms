import { permanentRedirect } from "next/navigation"

// LVE-010 (Wave 12 decision follow-up): the changelog lives at
// /changelog — the bare subdomain root redirects there permanently (308)
// instead of 404ing, keeping one canonical URL per index (the sitemap
// lists /changelog, not /). Page-level redirect from next/navigation,
// the repo's dominant redirect pattern (dashboard/admin pages); the
// permanent variant is used because the decision specifies a 308
// (redirect() would emit 307).
export default function RootPage() {
  permanentRedirect("/changelog")
}
