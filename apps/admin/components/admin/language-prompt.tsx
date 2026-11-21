"use client"

import { useEffect, useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sendcms/ui"
import {
  applyLocaleToDocument,
  detectBrowserLocale,
  getLocale,
  readLocaleCookie,
  writeLocaleCookie,
  type LocaleCode,
} from "@/lib/i18n-client"
import { useTranslation } from "@/components/admin/translation-provider"
import { usePersistLocale } from "@/components/admin/use-persist-locale"

/**
 * First-visit language prompt. When there is no stored preference
 * (no `sendcms-locale` cookie), the browser/system language is
 * detected; if it is a supported locale other than English, the admin
 * is asked whether to stay in English or switch. No detection (or an
 * English browser) means English stays the default and nothing pops.
 * Either choice is stored in the browser cookie and best-effort
 * persisted to the API — the UI never blocks on that call.
 */
export function LanguagePrompt() {
  const { t } = useTranslation("language")
  const persistLocale = usePersistLocale()
  const [detected, setDetected] = useState<LocaleCode | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Only ask once: a stored preference means the user already chose.
    if (readLocaleCookie() !== null) return
    const found = detectBrowserLocale()
    if (found && found !== "en") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Mount-only read of browser-only state (navigator.language). The dialog must not render during SSR, or hydration mismatches.
      setDetected(found)
      setOpen(true)
    }
  }, [])

  if (!detected) return null

  const nativeName = getLocale(detected)?.nativeName ?? detected

  const choose = (locale: LocaleCode) => {
    writeLocaleCookie(locale)
    persistLocale.mutate(locale)
    setOpen(false)
    if (locale !== "en") {
      applyLocaleToDocument(locale)
      // Reload so the server components re-render in the new locale.
      window.location.reload()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("detectedTitle")}</DialogTitle>
          <DialogDescription>
            {t("detectedMessage", { language: nativeName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => choose("en")}>
            {t("stayInEnglish")}
          </Button>
          <Button onClick={() => choose(detected)}>
            {t("switchLanguage", { language: nativeName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
