import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function NotificationsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent>
        {/* Digest summary card */}
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-96 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
