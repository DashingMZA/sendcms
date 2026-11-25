import { cookies } from "next/headers"
import {
  ADMIN_DOMAINS,
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
 * Server-side i18n adapter — the SINGLE place in the admin app that
 * imports `@sendcms/i18n` for server code. Client components use
 * `@/lib/i18n-client` instead (this module imports `next/headers`,
 * which client components cannot).
 *
 * How translation loading works here (see `packages/i18n/src/load.ts`):
 * shared domains live at `locales/{locale}/{domain}.json` and are
 * loaded with `loadLocaleDomain`; admin-app domains live at
 * `locales/{locale}/admin/{domain}.json` and are loaded with
 * `loadLocaleAppDomain(locale, "admin", domain)`. Both load by dynamic
 * import (no Node `fs`), so they work in server components.
 *
 * Fallback chain per key: requested locale → English → `[missing: key]`
 * (the i18n package's own marker, visible rather than silent). A missing
 * key never renders as a raw key while the English file has it.
 */
export {
  DEFAULT_LOCALE,
  createTranslator,
  getLocaleDirection,
  isSelectableLocale,
  isSupportedLocale,
}
export type { LocaleCode, LocaleInfo, TranslationMessages, Translator }

/** Cookie that carries the admin's chosen language (browser + server). */
export const LOCALE_COOKIE_NAME = "sendcms-locale"

/** Domains the admin shell loads for every page (nav, prompt, common). */
export const SHELL_TRANSLATION_DOMAINS = [
  "ai",
  "announcements",
  "audit-logs",
  "billing",
  "common",
  "errors",
  "features",
  "health",
  "navigation",
  "language",
  "dashboard",
  "mcp",
  "overview",
  "plans",
  "security",
  "settings",
  "step-up",
  "submissions",
  "subscriptions",
  "support",
  "translations",
  "usage",
  "users",
] as const

function isAdminDomain(domain: string): boolean {
  return (ADMIN_DOMAINS as readonly string[]).includes(domain)
}

/** Load one domain's messages for a locale ({} when the file is absent). */
async function loadMessages(
  locale: LocaleCode,
  domain: string
): Promise<TranslationMessages> {
  try {
    return isAdminDomain(domain)
      ? await loadLocaleAppDomain(locale, "admin", domain)
      : await loadLocaleDomain(locale, domain)
  } catch {
    return {}
  }
}

/**
 * Resolve the request locale: the cookie first, then the user's stored
 * preference in the database, then English (I18N-203 — mirrors the
 * dashboard adapter's `getRequestLocale(userId?)` → `getUserLocale`
 * shape; the admin adapter used to be cookie-only, so the persisted
 * preference was write-only). Only locales with complete translation
 * files resolve (I18N-307): a coming-soon code in the cookie or the DB
 * falls through to English, including the shell direction.
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

/**
 * Load one domain's translator for a locale, with per-key English
 * fallback.
 */
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
