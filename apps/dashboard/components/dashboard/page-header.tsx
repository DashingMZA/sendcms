// Client component: the sidebar trigger's accessible label comes from
// the `navigation` domain so it follows the page locale (I18N-104).
// Used only inside `/dashboard/*` pages, all under the dashboard
// layout's TranslationProvider, which loads `navigation` as a shell
// domain.
"use client"

import { SidebarTrigger } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

type Props = {
  title: string
  description?: string
  action?: React.ReactNode
}

export function PageHeader({ title, description, action }: Props) {
  const { t } = useTranslation("navigation")
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ms-1" label={t("toggleSidebar")} />
      <div className="flex flex-1 items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">{title}</h1>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>
    </header>
  )
}
