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
import { isSupportedLocale } from "./locales"

/** Shared domains that live at `locales/{locale}/{domain}.json`. */
export const SHARED_DOMAINS = [
  "actions",
  "admins",
  "appearance",
  "auth",
  "common",
  "confirmations",
  "empty-states",
  "email",
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
export const ADMIN_DOMAINS = [
  "activity",
  "ai",
  "announcements",
  "audit-logs",
  "billing",
  "dashboard",
  "features",
  "health",
  "jobs",
  "landing",
  "mcp",
  "navigation",
  "overview",
  "payments",
  "plans",
  "plans-subscriptions",
  "security",
  "settings",
  "step-up",
  "submissions",
  "subscriptions",
  "support",
  "translations",
  "trials",
  "usage",
  "users",
] as const

/** Dashboard-app domains that live at `locales/{locale}/dashboard/{domain}.json`. */
export const DASHBOARD_DOMAINS = [
  "account",
  "ai",
  "analytics",
  "api",
  "api-keys",
  "billing",
  "domains",
  "forms",
  "inbox",
  "landing",
  "navigation",
  "notifications",
  "overview",
  "support",
] as const

export type SharedDomain = (typeof SHARED_DOMAINS)[number]
export type AdminDomain = (typeof ADMIN_DOMAINS)[number]
export type DashboardDomain = (typeof DASHBOARD_DOMAINS)[number]

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

// A domain (or app) segment must be a single path segment: lowercase
// letters, digits, and hyphens only. Anything else (notably `..`, `/`,
// or `\`) is rejected before it can reach the dynamic import below,
// so locale loading can only ever resolve files under `locales/`.
const DOMAIN_SEGMENT = /^[a-z0-9-]+$/

function assertLoadablePath(
  locale: string,
  app: string | undefined,
  domain: string
): void {
  if (!isSupportedLocale(locale)) {
    throw new RangeError(`unsupported locale: ${JSON.stringify(locale)}`)
  }
  if (app !== undefined && !DOMAIN_SEGMENT.test(app)) {
    throw new RangeError(`invalid app segment: ${JSON.stringify(app)}`)
  }
  if (!DOMAIN_SEGMENT.test(domain)) {
    throw new RangeError(`invalid domain segment: ${JSON.stringify(domain)}`)
  }
}

/**
 * Validate that a dynamically imported JSON module is a string-valued
 * record. A JSON array, number, or record with non-string values is
 * not a message map: accepting it would make every key render
 * `[missing: key]`, so it is rejected loudly instead.
 */
export function isValidTranslationMessages(
  value: unknown
): value is TranslationMessages {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((entry) => typeof entry === "string")
}

/** Normalize a dynamically imported JSON module to its message map. */
function toMessages(mod: unknown): TranslationMessages {
  const candidate = (mod as { default?: unknown }).default ?? mod
  if (!isValidTranslationMessages(candidate)) {
    throw new TypeError("translation module is not a string-valued record")
  }
  return candidate
}

/**
 * Lazily load a shared domain file. Falls back to the registry when the
 * file was already registered (e.g. by the app shell).
 */
export async function loadLocaleDomain(
  locale: string,
  domain: string
): Promise<TranslationMessages> {
  assertLoadablePath(locale, undefined, domain)
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
  assertLoadablePath(locale, app, domain)
  const registered = getAppMessages(locale, app, domain)
  if (registered) return registered
  const mod = await import(`../locales/${locale}/${app}/${domain}.json`)
  const messages = toMessages(mod)
  registerAppTranslations(locale, app, domain, messages)
  return messages
}
