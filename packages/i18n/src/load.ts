// packages/i18n/src/load.ts
// Translation loading for the admin app.
//
// Two mechanisms, in order of preference:
//
// 1. Registry (preferred for the app shell and anything rendered
//    server-side): the app statically imports the JSON files it needs
//    (Next.js/Turbopack handles static JSON imports natively) and calls
//    `registerTranslations` / `registerAppTranslations` once. Reads are
//    then synchronous and cannot fail at runtime.
// 2. Dynamic import (`loadLocaleDomain` / `loadLocaleAppDomain`): lazy
//    loading of a domain on demand. The template-literal path lets the
//    bundler build a context module over `locales/`; it resolves at build
//    time, so no Node `fs` is ever used and the browser bundle is safe.
//
// Never use Node `fs` to read translations at runtime — the package is
// imported by client components too.

import {
  createTranslator,
  type TranslationMessages,
  type Translator,
} from "./translate"

/** Shared domains that live at `locales/{locale}/{domain}.json`. */
export const SHARED_DOMAINS = [
  "actions",
  "admins",
  "appearance",
  "auth",
  "common",
  "confirmations",
  "empty-states",
  "errors",
  "forms",
  "language",
  "notifications",
  "pagination",
  "profile",
  "security",
  "settings",
  "tables",
  "users",
  "validation",
] as const

/** Admin-app domains that live at `locales/{locale}/admin/{domain}.json`. */
export const ADMIN_DOMAINS = ["dashboard", "navigation", "users"] as const

export type SharedDomain = (typeof SHARED_DOMAINS)[number]
export type AdminDomain = (typeof ADMIN_DOMAINS)[number]

/** Relative path of a shared domain file, e.g. `locales/en/common.json`. */
export function translationPath(locale: string, domain: string): string {
  return `locales/${locale}/${domain}.json`
}

/** Relative path of an app-scoped domain file, e.g. `locales/en/admin/navigation.json`. */
export function translationAppPath(
  locale: string,
  app: string,
  domain: string
): string {
  return `locales/${locale}/${app}/${domain}.json`
}

// --- In-memory registry -------------------------------------------------

const registry = new Map<string, TranslationMessages>()

function registryKey(locale: string, domain: string, app?: string): string {
  return app ? `${locale}:${app}/${domain}` : `${locale}:${domain}`
}

export function registerTranslations(
  locale: string,
  domain: string,
  messages: TranslationMessages
): void {
  registry.set(registryKey(locale, domain), messages)
}

export function registerAppTranslations(
  locale: string,
  app: string,
  domain: string,
  messages: TranslationMessages
): void {
  registry.set(registryKey(locale, domain, app), messages)
}

export function getMessages(
  locale: string,
  domain: string
): TranslationMessages | undefined {
  return registry.get(registryKey(locale, domain))
}

export function getAppMessages(
  locale: string,
  app: string,
  domain: string
): TranslationMessages | undefined {
  return registry.get(registryKey(locale, domain, app))
}

export function hasTranslations(locale: string, domain: string): boolean {
  return registry.has(registryKey(locale, domain))
}

/** A translator for a registered domain; missing domains yield `[missing: key]`. */
export function getTranslator(locale: string, domain: string): Translator {
  return createTranslator(getMessages(locale, domain) ?? {})
}

// --- Dynamic loading ----------------------------------------------------

/** Normalize a dynamically imported JSON module to its message map. */
function toMessages(mod: unknown): TranslationMessages {
  const candidate = (mod as { default?: unknown }).default ?? mod
  return candidate as TranslationMessages
}

/**
 * Lazily load a shared domain file. Falls back to the registry when the
 * file was already registered (e.g. by the app shell).
 */
export async function loadLocaleDomain(
  locale: string,
  domain: string
): Promise<TranslationMessages> {
  const registered = getMessages(locale, domain)
  if (registered) return registered
  const mod = await import(`../locales/${locale}/${domain}.json`)
  const messages = toMessages(mod)
  registerTranslations(locale, domain, messages)
  return messages
}

/** Lazily load an app-scoped domain file (e.g. `admin/navigation`). */
export async function loadLocaleAppDomain(
  locale: string,
  app: string,
  domain: string
): Promise<TranslationMessages> {
  const registered = getAppMessages(locale, app, domain)
  if (registered) return registered
  const mod = await import(`../locales/${locale}/${app}/${domain}.json`)
  const messages = toMessages(mod)
  registerAppTranslations(locale, app, domain, messages)
  return messages
}
