// This skeleton lives in the (list) route group on purpose, not at
// app/dashboard/forms/loading.tsx: a loading.tsx wraps its segment's
// page AND every child route in Suspense, so a forms-level one streamed
// a 200 shell before the [formId] page could call notFound() — a missing
// or foreign form rendered the 404 UI with HTTP 200 (DSH-104). Scoped to
// the group, it wraps only the list page.
import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function FormsLoading() {
  return (
    <div>
      <PageHeaderSkeleton action />

      <PageContent>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
