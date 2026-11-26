import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Separator, Skeleton } from "@sendcms/ui"

export default function AnalyticsLoading() {
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

        {/* Activity chart */}
        <div className="flex flex-col gap-4">
          <Skeleton className="h-4 w-32" />
          <Separator />
          <Skeleton className="h-56 w-full" />
        </div>

        {/* By form + by domain */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-4 w-32" />
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
        </div>

        {/* By status */}
        <div className="flex flex-col gap-4">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-28 rounded-lg" />
            ))}
          </div>
        </div>
      </PageContent>
    </div>
  )
}
