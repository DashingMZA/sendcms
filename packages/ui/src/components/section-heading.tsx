import type { ReactNode } from "react"

import { cn } from "@sendcms/shared"

// The one section heading (Wave 10, UX-107): the single home of the
// `text-sm font-semibold tracking-wider text-muted-foreground uppercase`
// class string, previously copy-pasted 14 times across the dashboard.
// Detail-page section titles use CardTitle instead; this is for the
// chart/list section labels on the overview, analytics, and api pages.
export function SectionHeading({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <h2
      className={cn(
        "text-sm font-semibold tracking-wider text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </h2>
  )
}
