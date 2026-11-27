// All-users loading skeleton (Phase A, plan §3.2 — Wave 10 SRC-111
// pattern, modelled on the admin section loading boundary): mirrors
// the list page's own shape — PageHeader title + description, then
// the search/filter bar, then the users table. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar around
// this boundary, so a sidebar skeleton would render a duplicate next
// to it.
import { Skeleton } from "@sendcms/ui"

export default function AllUsersLoading() {
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
        {/* Search + filters bar */}
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-64 max-w-full" />
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-36" />
        </div>

        {/* Users table */}
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
