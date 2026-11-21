"use client"

import { createContext, useContext, type ReactNode } from "react"
import { interpolate, type TranslationMessages } from "@sendcms/i18n"

export type Dictionaries = Record<string, TranslationMessages>

const TranslationContext = createContext<Dictionaries>({})

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
