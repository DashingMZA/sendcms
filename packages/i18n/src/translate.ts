// packages/i18n/src/translate.ts
// Framework-free translator: `{name}` interpolation + plural support.
// A missing key renders as `[missing: key]` so it is visible in dev and
// never silently becomes an empty string.

export type TranslationMessages = Record<string, string>
export type TranslationVars = Record<string, string | number>

/** Replace `{name}` placeholders; unknown placeholders are left as-is. */
export function interpolate(
  template: string,
  vars: TranslationVars = {}
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

export type Translator = (key: string, vars?: TranslationVars) => string

export function createTranslator(messages: TranslationMessages): Translator {
  return (key, vars) => {
    const template = messages[key]
    if (template === undefined) return `[missing: ${key}]`
    return interpolate(template, vars)
  }
}

import { DEFAULT_LOCALE } from "./locales"

/**
 * Plural-aware formatting for the common `{count}` pattern.
 * `forms` maps Intl plural categories to templates, e.g.
 * `{ one: "{count} user", other: "{count} users" }`.
 *
 * Never throws on an unknown locale tag: like the `format.ts`
 * helpers, an unsupported locale falls back to English instead of
 * raising a RangeError.
 */
export function formatPlural(
  locale: string,
  count: number,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>,
  vars: TranslationVars = {}
): string {
  let rules: Intl.PluralRules
  try {
    rules = new Intl.PluralRules(locale)
  } catch {
    rules = new Intl.PluralRules(DEFAULT_LOCALE)
  }
  const rule = rules.select(count)
  const template = forms[rule] ?? forms.other ?? forms.one
  if (template === undefined) return "[missing: plural]"
  return interpolate(template, { ...vars, count })
}
