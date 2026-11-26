// Admin section loading skeleton (SRC-111): mirrors the admin pages'
// own shape — title + description, then content. The sidebar is NOT
// skeletonised here: the admin layout renders the real sidebar around
// this boundary, so a sidebar skeleton would render a duplicate next
// to it (same pattern as the dashboard's loading.tsx files). Admin
// pages have no h-16 header bar (no PageHeader — UX-005), so the
// skeleton mirrors their hand-rolled title block instead.
import { Skeleton } from "@sendcms/ui"

export default function AdminLoading() {
  return (
    <main
      id="main-content"
      className="flex flex-col gap-6 p-6"
      aria-label="Loading"
    >
      <div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>

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

      {/* Content table */}
      <div className="flex flex-col gap-4 rounded-xl border p-4">
        <Skeleton className="h-5 w-40" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </main>
  )
}
