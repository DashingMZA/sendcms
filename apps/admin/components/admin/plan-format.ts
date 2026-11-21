/** Shared formatting helpers for the admin plans UI. */

/** Format a minor-units price (cents) as major units, or `freeLabel` when null. */
export function formatPrice(
  priceAmount: number | null,
  currency: string,
  freeLabel: string
): string {
  if (priceAmount === null) return freeLabel
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(priceAmount / 100)
}

/** Format a nullable limit: null renders as the unlimited label. */
export function formatLimit(
  value: number | null,
  unlimitedLabel: string
): string {
  return value === null ? unlimitedLabel : String(value)
}

export function formatDate(value: string | Date | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function formatDateTime(value: string | Date | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
