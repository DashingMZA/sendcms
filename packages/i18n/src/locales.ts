// packages/i18n/src/locales.ts
// Locale registry for the SendCMS admin i18n system.
// English is the source locale. Phase 2 ships English + Urdu (LTR + RTL
// coverage); the other 8 locales are registered as coming-soon and land
// later without restructuring.

export type LocaleDirection = "ltr" | "rtl"
export type LocaleStatus = "complete" | "coming-soon"

export type LocaleCode =
  "en" | "ur" | "es" | "ar" | "fr" | "de" | "hi" | "bn" | "id" | "it"

export interface LocaleInfo {
  code: LocaleCode
  /** Language name in English. */
  name: string
  /** Language name in its own script. */
  nativeName: string
  dir: LocaleDirection
  status: LocaleStatus
}

export const SUPPORTED_LOCALES: readonly LocaleInfo[] = [
  {
    code: "en",
    name: "English",
    nativeName: "English",
    dir: "ltr",
    status: "complete",
  },
  {
    code: "ur",
    name: "Urdu",
    nativeName: "اردو",
    dir: "rtl",
    status: "complete",
  },
  {
    code: "es",
    name: "Spanish",
    nativeName: "Español",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "ar",
    name: "Arabic",
    nativeName: "العربية",
    dir: "rtl",
    status: "coming-soon",
  },
  {
    code: "fr",
    name: "French",
    nativeName: "Français",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "de",
    name: "German",
    nativeName: "Deutsch",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "hi",
    name: "Hindi",
    nativeName: "हिन्दी",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "bn",
    name: "Bengali",
    nativeName: "বাংলা",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "id",
    name: "Indonesian",
    nativeName: "Bahasa Indonesia",
    dir: "ltr",
    status: "coming-soon",
  },
  {
    code: "it",
    name: "Italian",
    nativeName: "Italiano",
    dir: "ltr",
    status: "coming-soon",
  },
]

export const DEFAULT_LOCALE: LocaleCode = "en"

/** Locales the user can actually pick today (complete translations only). */
export const SELECTABLE_LOCALES: readonly LocaleInfo[] =
  SUPPORTED_LOCALES.filter((locale) => locale.status === "complete")

export function isSupportedLocale(code: string): code is LocaleCode {
  return SUPPORTED_LOCALES.some((locale) => locale.code === code)
}

export function getLocale(code: string): LocaleInfo | undefined {
  return SUPPORTED_LOCALES.find((locale) => locale.code === code)
}

export function getLocaleDirection(code: string): LocaleDirection {
  return getLocale(code)?.dir ?? "ltr"
}

export function isRtl(code: string): boolean {
  return getLocaleDirection(code) === "rtl"
}

/**
 * Map a browser/system BCP 47 language tag (e.g. `navigator.language`)
 * to a locale the admin can actually render today. Only `en` and `ur`
 * are selectable in Phase 2, so anything that is not Urdu falls back to
 * English — never to a translation key or an incomplete locale.
 */
export function detectLocaleFromBrowserLanguage(
  navigatorLanguage: string | undefined
): "en" | "ur" {
  const primary = navigatorLanguage?.split("-")[0]?.toLowerCase()
  return primary === "ur" ? "ur" : "en"
}
