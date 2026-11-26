import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function AccountLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent className="max-w-md">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
