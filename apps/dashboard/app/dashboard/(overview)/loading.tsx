// This skeleton lives in the (overview) route group on purpose, not at
// app/dashboard/loading.tsx: a loading.tsx wraps its segment's page AND
// every child route in Suspense, so a dashboard-level one streamed a 200
// shell before a detail page could call notFound() — every missing or
// foreign resource rendered the 404 UI with HTTP 200 (DSH-104/204/409).
// Scoped to the group, it wraps only the overview page; the detail
// segments ([domainId], [formId], [submissionId], [ticketId]) have no
// loading boundary above them, so their notFound() yields a real 404.
import { Separator, Skeleton } from "@sendcms/ui"

export default function DashboardLoading() {
  return (
    <div>
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-48" />
        </div>
      </header>

      <div className="flex flex-col gap-8 p-8">
        {/* Stat cards */}
        <div className="grid gap-8 border-b pb-8 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-14" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Charts row */}
        <div className="flex flex-wrap gap-8 border-b pb-8">
          <div className="flex w-full max-w-[750px] flex-col gap-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Separator />
            <Skeleton className="h-48 w-full" />
          </div>
          <div className="flex min-w-[280px] flex-1 flex-col gap-3">
            <Skeleton className="h-4 w-32" />
            <Separator />
            <div className="flex flex-1 items-center gap-6 py-2">
              <Skeleton className="size-36 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Stats + Recent submissions */}
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-16" />
            </div>
            <Separator />
            <div className="flex flex-col">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-4">
                  <Skeleton className="size-9 shrink-0 rounded-md" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-3 w-20 shrink-0" />
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <Skeleton className="h-4 w-32" />
            <Separator />
            <div className="flex flex-col">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-4">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                  <Skeleton className="h-3 w-16 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
