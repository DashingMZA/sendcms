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
  return new Intl.DateTimeFormat(resolveLocale(locale), options).format(
    new Date(date)
  )
}

export function formatTime(
  locale: string,
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    hour: "numeric",
    minute: "numeric",
    ...options,
  }).format(new Date(date))
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
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: "currency",
    currency,
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
