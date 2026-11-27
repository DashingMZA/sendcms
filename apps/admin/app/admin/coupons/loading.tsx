// Coupons loading skeleton (Phase D, plan §3.7 — Wave 10 SRC-111
// pattern, modelled on the jobs loading skeleton): mirrors the
// page's own shape — PageHeader title + description, then the 3-stat
// row, then the tabs + search bar + table. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar
// around this boundary, so a sidebar skeleton would render a
// duplicate next to it.
import { Skeleton } from "@sendcms/ui"

export default function CouponsLoading() {
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
        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Table section */}
        <Skeleton className="h-10 w-72 max-w-full" />
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-64 max-w-full" />
        </div>
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
