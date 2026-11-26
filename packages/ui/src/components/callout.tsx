import type { ReactNode } from "react"

import { cn } from "@sendcms/shared"

type Props = {
  variant?: "warning" | "destructive"
  title?: string
  role?: "alert" | "status"
  className?: string
  children: ReactNode
}

const variantClasses = {
  warning: "border-warning/50 bg-warning/5 text-warning-foreground",
  destructive: "border-destructive/50 bg-destructive/10 text-destructive",
}

// The one callout (Wave 10, UX-112/203): title + body slots, one
// padding, token colors only — no per-site dark: overrides. The
// warning variant is the unified home of the two amber callouts
// (api-keys new key, AI BYOK notice) and the form-detail warnings;
// the destructive variant is for persistent error notices.
export function Callout({
  variant = "warning",
  title,
  role,
  className,
  children,
}: Props) {
  return (
    <div
      data-slot="callout"
      data-variant={variant}
      role={role}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4",
        variantClasses[variant],
        className
      )}
    >
      {title && <h2 className="text-sm font-semibold">{title}</h2>}
      <div className="text-sm">{children}</div>
    </div>
  )
}
