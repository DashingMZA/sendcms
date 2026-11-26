/**
 * Shared formatting helpers for the admin plans UI (I18N-010,
 * I18N-205): thin locale-first wrappers over the `@sendcms/i18n`
 * helpers. The page locale is the first argument everywhere — never
 * the browser runtime locale (`undefined` in the old code, which is
 * what rendered English dates on Urdu pages).
 */
import {
  formatCurrency,
  formatDate as formatDateI18n,
  formatNumber,
} from "@sendcms/i18n"

const SHORT_DATE: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
}

const SHORT_DATETIME: Intl.DateTimeFormatOptions = {
  ...SHORT_DATE,
  hour: "2-digit",
  minute: "2-digit",
}

/** Format a minor-units price (cents) as major units, or `freeLabel` when null. */
export function formatPrice(
  locale: string,
  priceAmount: number | null,
  currency: string,
  freeLabel: string
): string {
  if (priceAmount === null) return freeLabel
  return formatCurrency(locale, priceAmount / 100, currency)
}

/**
 * Format a minor-units payment amount as major units, or
 * `unknownLabel` when the amount is unknown (unmatched provider
 * event — the amount is never guessed). A null currency with a known
 * amount renders the plain number (formatCurrency falls back the
 * same way for a bad code).
 */
export function formatAmountMinor(
  locale: string,
  amountMinor: number | null,
  currency: string | null,
  unknownLabel: string
): string {
  if (amountMinor === null) return unknownLabel
  if (currency === null) return formatNumber(locale, amountMinor / 100)
  return formatCurrency(locale, amountMinor / 100, currency)
}

/** Format a nullable limit: null renders as the unlimited label. */
export function formatLimit(
  locale: string,
  value: number | null,
  unlimitedLabel: string
): string {
  return value === null ? unlimitedLabel : formatNumber(locale, value)
}

export function formatDate(
  locale: string,
  value: string | Date | null
): string {
  if (!value) return "—"
  return formatDateI18n(locale, value, SHORT_DATE)
}

export function formatDateTime(
  locale: string,
  value: string | Date | null
): string {
  if (!value) return "—"
  return formatDateI18n(locale, value, SHORT_DATETIME)
}
