// packages/i18n/src/format.ts
// Locale-aware formatting via Intl. Every helper resolves the locale
// first: an unknown or unsupported locale falls back to English instead
// of throwing a RangeError.

import { DEFAULT_LOCALE, isSupportedLocale } from "./locales"

function resolveLocale(locale: string): string {
  if (isSupportedLocale(locale)) return locale
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0
      ? locale
      : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function formatDate(
  locale: string,
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions
): string {
  const parsed = new Date(date)
  // An unparseable date has no honest rendering: return an empty
  // string instead of throwing a RangeError out of Intl.
  if (Number.isNaN(parsed.getTime())) return ""
  return new Intl.DateTimeFormat(resolveLocale(locale), options).format(parsed)
}

export function formatTime(
  locale: string,
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions
): string {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return ""
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    hour: "numeric",
    minute: "numeric",
    ...options,
  }).format(parsed)
}

export function formatNumber(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(resolveLocale(locale), options).format(value)
}

export function formatCurrency(
  locale: string,
  amount: number,
  currency: string
): string {
  // An invalid currency code (not a 3-letter ISO 4217 code) makes
  // Intl.NumberFormat throw. Never throw on bad input: fall back to a
  // plain number followed by the code as given, so the amount and the
  // (possibly wrong) code both stay visible instead of crashing the
  // render.
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    return `${formatNumber(locale, amount)} ${currency}`
  }
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount)
}

export function formatPercent(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: "percent",
    ...options,
  }).format(value)
}

export function formatRelativeTime(
  locale: string,
  value: number,
  unit: Intl.RelativeTimeFormatUnit
): string {
  return new Intl.RelativeTimeFormat(resolveLocale(locale), {
    numeric: "auto",
  }).format(value, unit)
}

/**
 * Relative distance between a date and now ("2 days ago" / "2 دن پہلے"),
 * in the caller's locale. Successor to the `date-fns`
 * `formatDistanceToNow` call sites, which default to English when no
 * locale is passed. Thresholds mirror date-fns' `formatDistanceToNow`
 * (45s / 45m / 22h / 25d / 11mo); `numeric: "auto"` renders "yesterday"
 * / "today" / "tomorrow" for ±1 day, matching date-fns' wording there.
 */
export function formatRelativeDate(
  locale: string,
  date: Date | string | number,
  now: Date | string | number = new Date()
): string {
  const diffSeconds = Math.round(
    (new Date(date).getTime() - new Date(now).getTime()) / 1000
  )
  const sign = diffSeconds < 0 ? -1 : 1
  const absSeconds = Math.abs(diffSeconds)
  const rtf = new Intl.RelativeTimeFormat(resolveLocale(locale), {
    numeric: "auto",
  })
  if (absSeconds < 45) return rtf.format(sign * absSeconds, "second")
  const minutes = Math.round(absSeconds / 60)
  if (minutes < 45) return rtf.format(sign * minutes, "minute")
  const hours = Math.round(absSeconds / 3600)
  if (hours < 22) return rtf.format(sign * hours, "hour")
  const days = Math.round(absSeconds / 86400)
  if (days < 25) return rtf.format(sign * days, "day")
  const months = Math.round(absSeconds / 2592000)
  if (months < 11) return rtf.format(sign * months, "month")
  return rtf.format(sign * Math.round(absSeconds / 31536000), "year")
}
