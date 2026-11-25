// This skeleton lives in the (list) route group on purpose, not at
// app/dashboard/forms/loading.tsx: a loading.tsx wraps its segment's
// page AND every child route in Suspense, so a forms-level one streamed
// a 200 shell before the [formId] page could call notFound() — a missing
// or foreign form rendered the 404 UI with HTTP 200 (DSH-104). Scoped to
// the group, it wraps only the list page.
import { Skeleton } from "@sendcms/ui"

export default function FormsLoading() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
