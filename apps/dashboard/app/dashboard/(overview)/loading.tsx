// This skeleton lives in the (overview) route group on purpose, not at
// app/dashboard/loading.tsx: a loading.tsx wraps its segment's page AND
// every child route in Suspense, so a dashboard-level one streamed a 200
// shell before a detail page could call notFound() — every missing or
// foreign resource rendered the 404 UI with HTTP 200 (DSH-104/204/409).
// Scoped to the group, it wraps only the overview page; the detail
// segments ([domainId], [formId], [submissionId], [ticketId]) have no
// loading boundary above them, so their notFound() yields a real 404.
import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Separator, Skeleton } from "@sendcms/ui"

export default function DashboardLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent>
        {/* Stat cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>

        {/* Charts row */}
        <div className="flex flex-wrap gap-6 border-b pb-8">
          <div className="flex w-full max-w-[750px] flex-col gap-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Separator />
            <Skeleton className="h-48 w-full" />
          </div>
          <div className="flex flex-1 flex-col gap-4">
            <Skeleton className="h-4 w-32" />
            <Separator />
            {/* DSH-005: the loaded status breakdown is three text rows
                (badge + count), not a donut chart — no circle here. */}
            <div className="flex flex-col gap-2.5 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="ms-auto h-4 w-8" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Stats + Recent submissions */}
        <div className="grid gap-6 lg:grid-cols-2">
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
      </PageContent>
    </div>
  )
}
