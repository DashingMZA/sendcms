// Trials loading skeleton (Phase A, plan §3.4 — Wave 10 SRC-111
// pattern, modelled on the admin section loading boundary and the
// all-users loading skeleton): mirrors the page's own shape —
// PageHeader title + description, then the 4-stat row, then the
// tabs + search/filter bar, then the table. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar around
// this boundary, so a sidebar skeleton would render a duplicate next
// to it.
import { Skeleton } from "@sendcms/ui"

export default function TrialsLoading() {
  return (
    <div>
      <div className="p-6 pb-0">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>

      <main
        id="main-content"
        className="flex flex-col gap-6 p-6"
        aria-label="Loading"
      >
        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Tabs */}
        <Skeleton className="h-10 w-72 max-w-full" />

        {/* Search + filters bar */}
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-64 max-w-full" />
          <Skeleton className="h-10 w-36" />
        </div>

        {/* Trials table */}
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </main>
    </div>
  )
}
