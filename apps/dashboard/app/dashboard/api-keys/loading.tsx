import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function ApiKeysLoading() {
  return (
    <div>
      <PageHeaderSkeleton action />

      <PageContent>
        {/* Create-key card */}
        <Skeleton className="h-40 w-full rounded-xl" />
        {/* Keys table card */}
        <Skeleton className="h-64 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
