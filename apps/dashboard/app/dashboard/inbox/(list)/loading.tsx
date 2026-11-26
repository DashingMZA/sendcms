// This skeleton lives in the (list) route group on purpose, not at
// app/dashboard/inbox/loading.tsx: a loading.tsx wraps its segment's
// page AND every child route in Suspense, so an inbox-level one streamed
// a 200 shell before the [submissionId] page could call notFound() — a
// missing or foreign submission rendered the 404 UI with HTTP 200
// (DSH-204). Scoped to the group, it wraps only the list page.
import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function InboxLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
