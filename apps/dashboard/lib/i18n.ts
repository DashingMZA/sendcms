import { cookies } from "next/headers"
import {
  DASHBOARD_DOMAINS,
  DEFAULT_LOCALE,
  createTranslator,
  getLocaleDirection,
  isSelectableLocale,
  isSupportedLocale,
  loadLocaleAppDomain,
  loadLocaleDomain,
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
  isSelectableLocale,
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

/** Dashboard-app domains loaded for the root landing page. */
export const DASHBOARD_LANDING_DOMAINS = ["landing"] as const

/** Dashboard-app domains loaded for the overview page. */
export const DASHBOARD_OVERVIEW_DOMAINS = ["overview"] as const

/** Dashboard-app domains loaded for the inbox pages. */
export const DASHBOARD_INBOX_DOMAINS = ["inbox"] as const

/** Dashboard-app domains loaded for the notifications page. */
export const DASHBOARD_NOTIFICATIONS_DOMAINS = ["notifications"] as const

/** Dashboard-app domains loaded for the analytics page. */
export const DASHBOARD_ANALYTICS_DOMAINS = ["analytics"] as const

/** Dashboard-app domains loaded for the domains pages. */
export const DASHBOARD_DOMAINS_DOMAINS = ["domains"] as const

/** Dashboard-app domains loaded for the forms pages. */
export const DASHBOARD_FORMS_DOMAINS = ["forms"] as const

/** Dashboard-app domains loaded for the API & SDK page. */
export const DASHBOARD_API_DOMAINS = ["api"] as const

/** Dashboard-app domains loaded for the API keys page. */
export const DASHBOARD_API_KEYS_DOMAINS = ["api-keys"] as const

/** Dashboard-app domains loaded for the account page. */
export const DASHBOARD_ACCOUNT_DOMAINS = ["account"] as const

/**
 * Domains the dashboard shell loads for every page: the shared
 * `language` domain (language selector) + the sidebar's `navigation`
 * domain.
 */
export const DASHBOARD_SHELL_DOMAINS = ["language", "navigation"] as const

function isDashboardDomain(domain: string): boolean {
  return (DASHBOARD_DOMAINS as readonly string[]).includes(domain)
}

/**
 * Load one domain's messages for a locale. Dashboard-app domains live
 * at `locales/{locale}/dashboard/{domain}.json`; anything else is a
 * shared domain at `locales/{locale}/{domain}.json` (mirrors the admin
 * adapter). Returns {} when the file is absent.
 */
async function loadMessages(
  locale: LocaleCode,
  domain: string
): Promise<TranslationMessages> {
  try {
    return isDashboardDomain(domain)
      ? await loadLocaleAppDomain(locale, "dashboard", domain)
      : await loadLocaleDomain(locale, domain)
  } catch {
    return {}
  }
}

/**
 * Resolve the request locale: the cookie first, then the user's stored
 * preference in the database, then English. Only locales with complete
 * translation files resolve (I18N-307): a coming-soon code in the
 * cookie or the DB falls through to English, including the shell
 * direction, so it can never render an RTL shell with English content.
 */
export async function getRequestLocale(userId?: string): Promise<LocaleCode> {
  const cookie = (await cookies()).get(LOCALE_COOKIE_NAME)?.value
  if (cookie && isSelectableLocale(cookie)) return cookie
  if (userId) {
    const stored = await getUserLocale(userId)
    if (stored && isSelectableLocale(stored)) return stored
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
