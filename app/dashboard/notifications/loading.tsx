import { Skeleton } from "@sendcms/ui"

export default function NotificationsLoading() {
  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-col gap-4">
        <div className="flex gap-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20" />
          ))}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  )
}
