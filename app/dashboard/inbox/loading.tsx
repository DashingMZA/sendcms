import { Skeleton } from "@sendcms/ui"

export default function InboxLoading() {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-col gap-4">
        <div className="flex gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20" />
          ))}
        </div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  )
}
