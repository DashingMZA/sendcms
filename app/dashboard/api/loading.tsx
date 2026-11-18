import { Skeleton } from "@/components/ui/skeleton"

export default function ApiLoading() {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  )
}
