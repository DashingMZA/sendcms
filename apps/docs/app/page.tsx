import { permanentRedirect } from "next/navigation"

// LVE-010 (Wave 12 decision follow-up): the docs index lives at /docs —
// the bare subdomain root redirects there permanently (308) instead of
// 404ing, keeping one canonical URL per index (the sitemap lists /docs,
// not /). Page-level redirect from next/navigation, the repo's dominant
// redirect pattern (dashboard/admin pages); the permanent variant is
// used because the decision specifies a 308 (redirect() would emit 307).
export default function RootPage() {
  permanentRedirect("/docs")
}
