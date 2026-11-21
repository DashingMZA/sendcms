import { RiInformationLine } from "@remixicon/react"
import { Badge } from "@sendcms/ui"

/**
 * Honest "not built yet" page for the admin sections that land in a
 * later phase. The established empty-state pattern (dashed border box
 * with icon, heading, description) — never fake data or fake stats.
 * The caller passes already-translated strings and the phase label.
 */
export function PlannedSection({
  title,
  description,
  phaseLabel,
}: {
  title: string
  description: string
  phaseLabel: string
}) {
  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-16 text-center">
        <RiInformationLine
          className="mb-3 size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="mb-2 text-xl font-bold tracking-tight">{title}</h1>
        <p className="mb-4 max-w-md leading-relaxed text-muted-foreground">
          {description}
        </p>
        <Badge variant="secondary">{phaseLabel}</Badge>
      </div>
    </main>
  )
}
