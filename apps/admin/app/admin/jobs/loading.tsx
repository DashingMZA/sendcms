// Jobs loading skeleton (Phase C, plan §3.6 — Wave 10 SRC-111
// pattern, modelled on the payments loading skeleton): mirrors the
// page's own shape — PageHeader title + description, then the 5-stat
// row, then the queue tabs + search/filter bar + table, then the cron
// runs table, then the worker card. The sidebar is NOT skeletonised
// here: the admin layout renders the real sidebar around this
// boundary, so a sidebar skeleton would render a duplicate next to it.
import { Skeleton } from "@sendcms/ui"

export default function JobsLoading() {
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Queue section */}
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-64 max-w-full" />
          <Skeleton className="h-10 w-36" />
        </div>
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>

        {/* Cron runs section */}
        <Skeleton className="h-6 w-32" />
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>

        {/* Worker card */}
        <div className="flex flex-col gap-4 rounded-xl border p-4">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </main>
    </div>
  )
}
