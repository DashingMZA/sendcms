// Shared admin page header (Wave 10, UX-005 / UX-001 / UX-201).
// Mirrors the dashboard's PageHeader: title + description + action slot
// + SidebarTrigger (the mobile sidebar Sheet opens only from a trigger).
// Adds an optional `back` prop — the shared back-link for detail/sub
// pages (UX-008): ghost button + arrow icon + label, rendered in the
// header bar before the title. `description` is a ReactNode so detail
// pages can pass rich content (e.g. a ltr-isolated email address).
"use client"

import Link from "next/link"
import { RiArrowLeftLine } from "@remixicon/react"
import { Button, SidebarTrigger } from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

type Props = {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  back?: { href: string; label: string }
}

export function PageHeader({ title, description, action, back }: Props) {
  const { t } = useTranslation("navigation")
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ms-1" label={t("toggleSidebar")} />
      {back && (
        <Button asChild variant="ghost" size="sm" className="-ms-2">
          <Link href={back.href}>
            <RiArrowLeftLine className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{back.label}</span>
          </Link>
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {description && (
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  )
}
