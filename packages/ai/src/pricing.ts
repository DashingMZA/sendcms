// AI cost attribution (Phase 16, Wave 8: DB-033). `AiUsageRecord.
// costMicros` was always NULL: the writer accepted it, the summary
// summed it, the admin UI formatted it — but no caller ever passed
// it, because the SDK surfaces token counts, not cost, and the repo
// had no price table to turn tokens into cost.
//
// This is that price table: published list prices (USD per 1M
// tokens) for the models SendCMS can call. Cost is computed from
// the provider-reported token counts at record time —
// `costMicros = round(tokensIn * priceIn + tokensOut * priceOut)`
// (tokens × USD-per-token × 1e6 micros/USD simplifies to tokens ×
// price-per-1M-tokens). An unknown model returns null — never an
// estimate, never a guess from another model's price — so a row
// with `costMicros = NULL` means "price unknown", not "free".
// Prices drift; update this table when a provider reprices, and
// keep the drift-guard test (tests/wave8-stream-c.test.ts) in sync
// with the models in DEFAULT_MODELS.
export const MODEL_PRICES_USD_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number }
> = {
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  // Anthropic
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  // Google Gemini
  "gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3.8-flash": { input: 0.5, output: 3 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  // OpenRouter (same underlying model, OpenRouter's price)
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "google/gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
}

/** Cost of one call in micro-dollars, from provider-reported
    token counts, or null when the model has no price row. */
export function estimateAiCallCostMicros(
  modelId: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined
): number | null {
  if (!modelId) return null
  const price = MODEL_PRICES_USD_PER_MILLION_TOKENS[modelId.trim()]
  if (!price) return null
  if (
    typeof tokensIn !== "number" ||
    typeof tokensOut !== "number" ||
    !Number.isFinite(tokensIn) ||
    !Number.isFinite(tokensOut)
  ) {
    return null
  }
  return Math.round(tokensIn * price.input + tokensOut * price.output)
}
