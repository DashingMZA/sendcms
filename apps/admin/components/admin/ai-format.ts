/** Shared formatting helpers for the admin AI UI. */

/**
 * Format a provider-reported cost (micro-dollars, 1e-6 USD) as
 * dollars. Returns null when nothing was reported — a zero total
 * means "no provider reported a cost", not "free", so callers render
 * the no-cost label instead of $0.00.
 */
export function formatCostMicros(costMicros: number): string | null {
  if (costMicros <= 0) return null
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(costMicros / 1_000_000)
}

/** Format an error rate (0–1) as a percentage, or "—" when unknown. */
export function formatErrorRate(errorRate: number | null): string {
  if (errorRate === null) return "—"
  return `${(errorRate * 100).toFixed(1)}%`
}

/** Provider display names (proper nouns — never translated). */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}
