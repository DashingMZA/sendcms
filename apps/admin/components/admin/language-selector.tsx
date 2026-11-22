"use client"

import { useEffect, useState } from "react"
import { RiCheckLine, RiGlobalLine } from "@remixicon/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sendcms/ui"
import {
  SELECTABLE_LOCALES,
  applyLocaleToDocument,
  getLocale,
  readLocaleCookie,
  writeLocaleCookie,
  type LocaleCode,
} from "@/lib/i18n-client"
import { useTranslation } from "@/components/admin/translation-provider"
import { usePersistLocale } from "@/components/admin/use-persist-locale"

/**
 * Language selector in the sidebar footer. Lists the locales whose
 * translation files are complete (English + Urdu in Phase 2); the
 * other registered locales appear once their files land. Switching
 * stores the choice in the browser cookie and best-effort in the
 * database, then reloads so the whole UI re-renders in the new
 * language. The choice sticks until the user changes it again.
 *
 * `side` is the sidebar's side (left in LTR, right in RTL) — the
 * collapsed-icon tooltip sits on the sidebar's outer side.
 */
export function LanguageSelector({ side }: { side: "left" | "right" }) {
  const { t } = useTranslation("language")
  const persistLocale = usePersistLocale()
  const [current, setCurrent] = useState<LocaleCode>("en")

  // Read the cookie after mount (not during render) so server and
  // client render the same first pass — no hydration mismatch.
  useEffect(() => {
    const saved = readLocaleCookie()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Mount-only cookie read: the server renders "en" and the client corrects after hydration, so there is no hydration mismatch.
    if (saved) setCurrent(saved as LocaleCode)
  }, [])

  const available = SELECTABLE_LOCALES

  const switchLocale = (locale: LocaleCode) => {
    if (locale === current) return
    setCurrent(locale)
    writeLocaleCookie(locale)
    persistLocale.mutate(locale)
    applyLocaleToDocument(locale)
    window.location.reload()
  }

  const currentName = getLocale(current)?.nativeName ?? current.toUpperCase()

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={{
              children: t("title"),
              side: side === "right" ? "left" : "right",
            }}
          >
            <RiGlobalLine className="size-4 shrink-0" aria-hidden="true" />
            <span className="group-data-[collapsible=icon]:hidden">
              {currentName}
            </span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel>{t("title")}</DropdownMenuLabel>
          {available.map((locale) => (
            <DropdownMenuItem
              key={locale.code}
              onSelect={() => switchLocale(locale.code)}
              className="cursor-pointer"
            >
              <span className="flex-1">{locale.nativeName}</span>
              {locale.code === current && (
                <RiCheckLine className="size-4" aria-hidden="true" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
