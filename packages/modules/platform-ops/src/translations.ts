import type { AdminSession } from "@sendcms/auth"
import {
  ADMIN_DOMAINS,
  DASHBOARD_DOMAINS,
  SHARED_DOMAINS,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  loadLocaleAppDomain,
  loadLocaleDomain,
  type LocaleCode,
} from "@sendcms/i18n"
import { ApiError } from "@sendcms/shared"
import { requireAdmin } from "./require-admin"

// Translation completion (Admin Control Plane, Phase 7).
// Framework-independent (no Next.js imports). Read-only, and
// deliberately so: no ordinary admin may overwrite translation
// files from the browser — translation changes go through the
// version-controlled workflow (see docs/admin-control-plane/
// translation-management.md). AI translation is NOT built (it is
// permission-controlled, reviewable, and deferred).
//
// Every comparison goes through @sendcms/i18n's loaders
// (loadLocaleDomain / loadLocaleAppDomain) — never Node `fs` reads.
// A locale with no files for a domain simply has every key missing;
// a load failure for one domain never fails the whole report.

export type TranslationDomainCompletion = {
  domain: string
  app: "shared" | "admin" | "dashboard"
  total: number
  translated: number
  missingKeys: string[]
}

export type TranslationLocaleCompletion = {
  code: LocaleCode
  name: string
  nativeName: string
  dir: "ltr" | "rtl"
  status: "complete" | "coming-soon"
  overallPercent: number
  domains: TranslationDomainCompletion[]
}

async function loadDomain(
  locale: string,
  app: "shared" | "admin" | "dashboard",
  domain: string
): Promise<Record<string, unknown>> {
  try {
    if (app === "shared") return await loadLocaleDomain(locale, domain)
    return await loadLocaleAppDomain(locale, app, domain)
  } catch {
    // No files for this locale/domain (e.g. a coming-soon locale):
    // every key is missing, and the report still completes.
    return {}
  }
}

type DomainRef = { app: "shared" | "admin" | "dashboard"; domain: string }

function allDomains(): DomainRef[] {
  return [
    ...SHARED_DOMAINS.map((domain) => ({ app: "shared" as const, domain })),
    ...ADMIN_DOMAINS.map((domain) => ({ app: "admin" as const, domain })),
    ...DASHBOARD_DOMAINS.map((domain) => ({
      app: "dashboard" as const,
      domain,
    })),
  ]
}

/** Per-locale, per-domain completion against `en` (the source).
    Reads need MANAGE_TRANSLATIONS. `en` itself is always 100%. */
export async function getTranslationCompletion(
  actor: AdminSession
): Promise<{ locales: TranslationLocaleCompletion[] }> {
  requireAdmin(actor, "MANAGE_TRANSLATIONS")
  const domains = allDomains()
  // The source of truth: every key of every domain in English.
  const source = new Map<string, string[]>()
  for (const { app, domain } of domains) {
    const messages = await loadDomain("en", app, domain)
    source.set(`${app}/${domain}`, Object.keys(messages))
  }
  const locales: TranslationLocaleCompletion[] = []
  for (const locale of SUPPORTED_LOCALES) {
    const rows: TranslationDomainCompletion[] = []
    let totalKeys = 0
    let translatedKeys = 0
    for (const { app, domain } of domains) {
      const sourceKeys = source.get(`${app}/${domain}`) ?? []
      const messages = await loadDomain(locale.code, app, domain)
      const missingKeys = sourceKeys.filter((key) => !(key in messages))
      const translated = sourceKeys.length - missingKeys.length
      totalKeys += sourceKeys.length
      translatedKeys += translated
      rows.push({
        domain,
        app,
        total: sourceKeys.length,
        translated,
        missingKeys,
      })
    }
    locales.push({
      code: locale.code,
      name: locale.name,
      nativeName: locale.nativeName,
      dir: locale.dir,
      status: locale.status,
      overallPercent:
        totalKeys === 0 ? 100 : Math.round((translatedKeys / totalKeys) * 100),
      domains: rows,
    })
  }
  return { locales }
}

/** One locale's translation files as a single JSON bundle, for
    external review. Read-only. Reads need MANAGE_TRANSLATIONS. */
export async function exportTranslations(
  actor: AdminSession,
  locale: string
): Promise<{
  locale: string
  domains: Record<string, Record<string, unknown>>
}> {
  requireAdmin(actor, "MANAGE_TRANSLATIONS")
  if (!isSupportedLocale(locale)) {
    throw new ApiError(`Unknown locale: ${locale}.`, 422)
  }
  const domains: Record<string, Record<string, unknown>> = {}
  for (const { app, domain } of allDomains()) {
    const key = app === "shared" ? domain : `${app}/${domain}`
    domains[key] = await loadDomain(locale, app, domain)
  }
  return { locale, domains }
}
