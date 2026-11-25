"use client"

import { createContext, useContext, type ReactNode } from "react"
import { interpolate, type TranslationMessages } from "@sendcms/i18n"

export type Dictionaries = Record<string, TranslationMessages>

const TranslationContext = createContext<Dictionaries>({})

const LocaleContext = createContext<string>("en")

/**
 * Locale provider for the admin app. The root layout resolves the
 * request locale server-side and hands it here, so client components
 * can format dates, times, numbers and currency in the page locale
 * (I18N-010) instead of the browser runtime locale. Kept separate
 * from the dictionaries context so a nested provider can never
 * shadow it.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: string
  // Optional so `React.createElement(LocaleProvider, { locale }, child)`
  // type-checks: the props object need not carry `children` when they
  // are passed as separate arguments. All real call sites pass children.
  children?: ReactNode
}) {
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  )
}

/** Current page locale ("en" | "ur"); defaults to English outside a provider. */
export function useLocale(): string {
  return useContext(LocaleContext)
}

/**
 * Client translation provider. The root layout loads the merged
 * dictionaries server-side (requested locale → English → hardcoded
 * fallback) and hands them here, so client components translate
 * without fetching.
 */
export function TranslationProvider({
  dictionaries,
  children,
}: {
  dictionaries: Dictionaries
  children: ReactNode
}) {
  return (
    <TranslationContext.Provider value={dictionaries}>
      {children}
    </TranslationContext.Provider>
  )
}

/**
 * Translate within a domain. Supports `{var}` interpolation:
 * `t("key", { name })`. A key missing from every dictionary renders
 * as `[missing: key]` (the i18n package's own marker) — visible
 * rather than silent, and never an empty string.
 */
export function useTranslation(domain: string) {
  const dictionaries = useContext(TranslationContext)
  const t = (key: string, vars?: Record<string, string | number>): string => {
    const template = dictionaries[domain]?.[key]
    if (template === undefined) return `[missing: ${key}]`
    return interpolate(template, vars)
  }
  return { t }
}
