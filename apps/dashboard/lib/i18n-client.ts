import {
  SELECTABLE_LOCALES,
  getLocale,
  getLocaleDirection,
  type LocaleCode,
  type LocaleInfo,
} from "@sendcms/i18n"

/**
 * Client-side i18n adapter — the SINGLE place in the dashboard app
 * that imports `@sendcms/i18n` for client code. Server code uses
 * `@/lib/i18n` instead.
 *
 * `SELECTABLE_LOCALES` is the list of locales with complete
 * translation files (en + ur in Phase 2).
 */
export { SELECTABLE_LOCALES, getLocale, getLocaleDirection }
export type { LocaleCode, LocaleInfo }

/** Cookie that carries the user's chosen language (browser + server). */
export const LOCALE_COOKIE_NAME = "sendcms-locale"

/** Read the locale cookie in the browser; null when absent. */
export function readLocaleCookie(): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`))
  return match
    ? decodeURIComponent(match.slice(LOCALE_COOKIE_NAME.length + 1))
    : null
}

/** Persist the chosen locale in the browser (1 year, site-wide). */
export function writeLocaleCookie(locale: LocaleCode): void {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000; SameSite=Lax`
}

/** Apply the locale to the document element (lang + direction). */
export function applyLocaleToDocument(locale: LocaleCode): void {
  document.documentElement.lang = locale
  document.documentElement.dir = getLocaleDirection(locale)
}
