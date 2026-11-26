import type { ComponentType, ReactNode } from "react"

type Props = {
  icon: ComponentType<{
    className?: string
    "aria-hidden"?: boolean | "true" | "false"
  }>
  title: string
  description?: string
  /** Optional call-to-action (usually a Button). Pages whose create
      form is always visible (e.g. api-keys) pass no CTA. */
  cta?: ReactNode
}

// The one empty state (Wave 10, UX-104): dashed box + icon + heading
// + description + optional CTA, one padding. Replaces the four
// hand-rolled patterns (dashed box with/without CTA, inline table row,
// Card box, plain paragraph).
export function EmptyState({ icon: Icon, title, description, cta }: Props) {
  return (
    <div
      data-slot="empty-state"
      className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center"
    >
      <Icon className="mb-4 size-10 text-muted-foreground" aria-hidden="true" />
      <h3 className="mb-1 text-lg font-semibold text-balance">{title}</h3>
      {description && (
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {cta && <div className={description ? undefined : "mt-3"}>{cta}</div>}
    </div>
  )
}
