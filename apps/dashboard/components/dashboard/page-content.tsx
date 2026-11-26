import type { ReactNode } from "react"

import { cn } from "@sendcms/shared"

// The one content container for dashboard pages (Wave 10, UX-103/210):
// one padding (p-4 sm:p-6 lg:p-8) and one section gap (gap-6) for every
// page. Pages render PageHeader full-width above this — the header bar
// must not be inset, so the padding cannot live in the dashboard
// layout. Width constraints (api max-w-3xl, account max-w-md) pass
// through className.
export function PageContent({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-6 p-4 sm:p-6 lg:p-8", className)}>
      {children}
    </div>
  )
}
