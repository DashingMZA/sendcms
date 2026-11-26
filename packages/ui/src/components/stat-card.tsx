import type { ComponentType } from "react"

import { cn } from "@sendcms/shared"
import { Card, CardContent } from "./card"

type Props = {
  title: string
  value: number | string
  icon: ComponentType<{
    className?: string
    "aria-hidden"?: boolean | "true" | "false"
  }>
  description?: string
  variant?: "default" | "warning" | "success" | "destructive"
}

const valueColor = {
  default: "text-foreground",
  warning: "text-warning",
  success: "text-success",
  destructive: "text-destructive",
}

// One stat pattern for the dashboard and admin overviews (Wave 10,
// UX-101/102): a stat lives in a shared Card with one value size
// (text-2xl font-semibold — the admin's size). The dashboard's old
// borderless text-3xl stat is gone.
export function StatCard({
  title,
  value,
  icon: Icon,
  description,
  variant = "default",
}: Props) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {title}
          </span>
        </div>
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums",
            valueColor[variant]
          )}
        >
          {value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  )
}
