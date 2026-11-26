import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function AiLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent>
        {/* Billing-mode selector */}
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-40 rounded-lg" />
          ))}
        </div>
        {/* One provider key card per provider (5) */}
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </PageContent>
    </div>
  )
}
