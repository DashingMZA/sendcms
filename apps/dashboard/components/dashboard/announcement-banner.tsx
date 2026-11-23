"use client"

import { useEffect, useState } from "react"
import { useActiveAnnouncements } from "@sendcms/platform-ops/queries"
import { Button } from "@sendcms/ui"
import { RiCloseLine, RiMegaphoneLine } from "@remixicon/react"
import { useTranslation } from "@/components/dashboard/translation-provider"

const DISMISSED_KEY = "sendcms-dismissed-announcements"

/** Read the dismissed announcement ids from this browser. */
function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : []
  } catch {
    return []
  }
}

/**
 * The customer dashboard announcement banner (Phase 7): the active
 * announcements for the customer audience (the route decides the
 * audience from the actor — customers see audience ALL only). The
 * title and body come from the API (admin-authored, not translated);
 * only the dismiss label is translated (navigation domain, loaded by
 * the shell). Dismissals are stored in this browser only.
 */
export function AnnouncementBanner() {
  const { data, isLoading } = useActiveAnnouncements()
  const { t } = useTranslation("navigation")
  // null until the first client render has read the dismissals — the
  // server renders nothing, so the first render matches it.
  const [dismissed, setDismissed] = useState<string[] | null>(null)

  // localStorage is browser-only: read it after mount so the first
  // render matches the server and never flashes a banner the user
  // already dismissed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM read on mount (SSR/hydration safety)
    setDismissed(readDismissed())
  }, [])

  function dismiss(id: string) {
    const next = [...(dismissed ?? []), id]
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // Dismissal is best-effort; the banner just reappears.
    }
  }

  if (dismissed === null || isLoading) return null
  const visible = (data?.announcements ?? []).filter(
    (row) => !dismissed.includes(row.id)
  )
  if (visible.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {visible.map((row) => (
        <div
          key={row.id}
          className="flex items-start gap-3 rounded-lg border bg-primary/5 p-4"
        >
          <RiMegaphoneLine
            className="mt-0.5 size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{row.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{row.body}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => dismiss(row.id)}
            aria-label={t("dismissAnnouncement")}
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  )
}
