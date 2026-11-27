// Activity loading skeleton (Phase B, plan §3.1 — Wave 10 SRC-111
// pattern, modelled on the trials loading skeleton): mirrors the
// page's own shape — PageHeader title + description, then the tabs,
// then the filters card, then the feed list. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar around
// this boundary, so a sidebar skeleton would render a duplicate next
// to it.
import { Skeleton } from "@sendcms/ui"

export default function ActivityLoading() {
  return (
    <div>
      <div className="p-6 pb-0">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>

      <div
        tabIndex={-1}
        className="flex flex-col gap-6 p-6"
        aria-label="Loading"
      >
        {/* Tabs */}
        <Skeleton className="h-10 w-96 max-w-full" />

        {/* Filters card */}
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>

        {/* Feed rows */}
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}
