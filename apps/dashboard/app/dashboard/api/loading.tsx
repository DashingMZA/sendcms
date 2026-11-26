import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function ApiLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent className="max-w-3xl">
        {/* API key + base URL, embed snippet, webhook, rate limits */}
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ))}
      </PageContent>
    </div>
  )
}
