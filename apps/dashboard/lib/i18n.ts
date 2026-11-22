import { cookies } from "next/headers"
import {
  DEFAULT_LOCALE,
  createTranslator,
  getLocaleDirection,
  isSupportedLocale,
  loadLocaleAppDomain,
  type LocaleCode,
  type LocaleInfo,
  type TranslationMessages,
  type Translator,
} from "@sendcms/i18n"
import { getUserLocale } from "@sendcms/users"

/**
 * Server-side i18n adapter for the dashboard app — the SINGLE place
 * in the dashboard app that imports `@sendcms/i18n` for server code.
 * Mirrors the admin app's adapter (`apps/admin/lib/i18n.ts`), but for
 * dashboard-app domains, which live at
 * `locales/{locale}/dashboard/{domain}.json`.
 *
 * The dashboard has no language prompt yet, so the locale resolves
 * cookie-first (`sendcms-locale`, shared with the admin app) and then
 * falls back to the user's stored preference in the database, then
 * English. Client components use the translation provider in
 * `@/components/dashboard/translation-provider`.
 *
 * Fallback chain per key: requested locale → English → `[missing: key]`
 * (the i18n package's own marker, visible rather than silent).
 */
export {
  DEFAULT_LOCALE,
  createTranslator,
  getLocaleDirection,
  isSupportedLocale,
}
export type { LocaleCode, LocaleInfo, TranslationMessages, Translator }

/** Cookie that carries the user's chosen language (browser + server). */
export const LOCALE_COOKIE_NAME = "sendcms-locale"

/** Dashboard-app domains loaded for the AI page. */
export const DASHBOARD_AI_DOMAINS = ["ai"] as const

/** Dashboard-app domains loaded for the billing pages. */
export const DASHBOARD_BILLING_DOMAINS = ["billing"] as const

/** Dashboard-app domains loaded for the support pages. */
export const DASHBOARD_SUPPORT_DOMAINS = ["support"] as const

/** Load one dashboard domain's messages for a locale. */
async function loadMessages(
  locale: LocaleCode,
  domain: string
): Promise<TranslationMessages> {
  try {
    return await loadLocaleAppDomain(locale, "dashboard", domain)
  } catch {
    return {}
  }
}

/**
 * Resolve the request locale: the cookie first, then the user's stored
 * preference in the database, then English.
 */
export async function getRequestLocale(userId?: string): Promise<LocaleCode> {
  const cookie = (await cookies()).get(LOCALE_COOKIE_NAME)?.value
  if (cookie && isSupportedLocale(cookie)) return cookie
  if (userId) {
    const stored = await getUserLocale(userId)
    if (stored && isSupportedLocale(stored)) return stored
  }
  return DEFAULT_LOCALE
}

/** Load one domain's translator for a locale, with per-key English fallback. */
export async function getTranslator(
  locale: LocaleCode,
  domain: string
): Promise<Translator> {
  const [messages, enMessages] = await Promise.all([
    loadMessages(locale, domain),
    locale === DEFAULT_LOCALE
      ? Promise.resolve({} as TranslationMessages)
      : loadMessages(DEFAULT_LOCALE, domain),
  ])
  return createTranslator({
    ...enMessages,
    ...messages,
  })
}

export type Dictionaries = Record<string, TranslationMessages>

/** Load merged dictionaries (locale + English) for the client provider. */
export async function getDictionaries(
  locale: LocaleCode,
  domains: readonly string[]
): Promise<Dictionaries> {
  const entries = await Promise.all(
    domains.map(async (domain) => {
      const [messages, enMessages] = await Promise.all([
        loadMessages(locale, domain),
        locale === DEFAULT_LOCALE
          ? Promise.resolve({} as TranslationMessages)
          : loadMessages(DEFAULT_LOCALE, domain),
      ])
      return [
        domain,
        {
          ...enMessages,
          ...messages,
        },
      ] as const
    })
  )
  return Object.fromEntries(entries) as Dictionaries
}
