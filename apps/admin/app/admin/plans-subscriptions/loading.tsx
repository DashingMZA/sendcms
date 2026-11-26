// Plans & Subscriptions loading skeleton (Phase A, plan §3.3 —
// Wave 10 SRC-111 pattern, modelled on the admin section loading
// boundary): mirrors the combined page's own shape — PageHeader bar,
// stat-card row, tab list, then the table. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar around
// this boundary, so a sidebar skeleton would render a duplicate next
// to it.
import { Skeleton } from "@sendcms/ui"

export default function PlansSubscriptionsLoading() {
  return (
    <div>
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <Skeleton className="h-6 w-56" />
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
        <Skeleton className="h-9 w-64 max-w-full" />

        {/* Content table */}
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
