import { Skeleton } from "@sendcms/ui"

/**
 * Mirrors PageHeader (the h-16 bar with sidebar trigger, title and
 * description) for loading.tsx skeletons. `action` adds the right-side
 * primary-action skeleton for pages whose PageHeader carries one.
 */
export function PageHeaderSkeleton({ action = false }: { action?: boolean }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <Skeleton className="size-7 shrink-0 rounded-md" />
      <div className="flex flex-1 items-center justify-between">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-48" />
        </div>
        {action && <Skeleton className="h-9 w-24" />}
      </div>
    </header>
  )
}
