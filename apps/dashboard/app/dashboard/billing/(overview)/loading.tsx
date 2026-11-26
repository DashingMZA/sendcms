// This skeleton lives in the (overview) route group on purpose, not at
// app/dashboard/billing/loading.tsx: a loading.tsx wraps its segment's
// page AND every child route in Suspense, so a billing-level one would
// wrap the checkout/ child too. Scoped to the group, it wraps only the
// billing overview page (mirrors the DSH-104 pattern).
import { PageHeaderSkeleton } from "@/components/dashboard/page-header-skeleton"
import { PageContent } from "@/components/dashboard/page-content"
import { Skeleton } from "@sendcms/ui"

export default function BillingLoading() {
  return (
    <div>
      <PageHeaderSkeleton />

      <PageContent>
        {/* Current plan card + usage card */}
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </PageContent>
    </div>
  )
}
