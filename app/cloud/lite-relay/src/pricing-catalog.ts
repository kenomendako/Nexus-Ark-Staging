import type { CanonicalUsage, Provider } from "./types";

export const PRICING_VERSION = "2026-09-04.1";

export type EstimateStatus = "estimated" | "free_key_reference" | "unknown_price" | "missing_usage";
export type CostBasis = "provider_reported" | "catalog" | "none";

export interface PriceRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheStoragePerMillionTokenHour?: number;
}

interface PriceEntry {
  provider: Provider;
  model: RegExp;
  rates: PriceRates;
  sourceUrl: string;
  longContext?: { minimumInputTokens: number; rates: PriceRates };
}

// 運用モデルの選択肢ではなく、公式料金を確認済みのモデルIDだけを版付きで照合するカタログ。
const PRICE_CATALOG: PriceEntry[] = [
  {
    provider: "gemini",
    model: /^gemini-3-flash-preview(?:-[0-9-]+)?$/,
    rates: { input: 0.5, output: 3 },
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "gemini",
    model: /^gemini-3\.5-flash-lite(?:-[0-9-]+)?$/,
    rates: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3, cacheStoragePerMillionTokenHour: 1 },
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "gemini",
    model: /^gemini-2\.5-flash-lite(?:-[0-9-]+)?$/,
    rates: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1, cacheStoragePerMillionTokenHour: 1 },
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  {
    provider: "openai",
    model: /^gpt-5\.4-nano(?:-[0-9-]+)?$/,
    rates: { input: 0.2, output: 1.25, cacheRead: 0.02 },
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
  },
  {
    provider: "anthropic",
    model: /^claude-haiku-4-5(?:-[0-9]+)?$/,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
  {
    provider: "xai",
    model: /^grok-4\.3(?:-[0-9-]+)?$/,
    rates: { input: 1.25, output: 2.5, cacheRead: 0.2 },
    longContext: {
      minimumInputTokens: 131_072,
      rates: { input: 2.5, output: 5, cacheRead: 0.4 },
    },
    sourceUrl: "https://docs.x.ai/developers/pricing",
  },
  {
    provider: "openrouter",
    model: /^openai\/gpt-5\.4-nano$/,
    rates: { input: 0.2, output: 1.25, cacheRead: 0.02 },
    sourceUrl: "https://openrouter.ai/docs/guides/overview/models",
  },
];

export interface PricingMetadata {
  pricingVersion: string;
  provider: Provider;
  model: string;
  rates: PriceRates;
  sourceUrl: string;
  longContextApplied: boolean;
}

export interface CostBreakdown {
  pricing_version: string | null;
  cost_basis: CostBasis;
  estimate_status: EstimateStatus;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  cache_read_cost_usd: number | null;
  cache_creation_cost_usd: number | null;
  cache_storage_cost_usd: number | null;
  estimated_cost_usd: number | null;
  estimated_savings_usd: number | null;
  unknown_reason: "model_price_unavailable" | "usage_missing" | null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function lookupPrice(provider: Provider, model: string, inputTokens = 0): PricingMetadata | null {
  const entry = PRICE_CATALOG.find((item) => item.provider === provider && item.model.test(model));
  if (!entry) return null;
  const longContextApplied = Boolean(entry.longContext && inputTokens >= entry.longContext.minimumInputTokens);
  return {
    pricingVersion: PRICING_VERSION,
    provider,
    model,
    rates: longContextApplied ? entry.longContext!.rates : entry.rates,
    sourceUrl: entry.sourceUrl,
    longContextApplied,
  };
}

export function estimateUsageCost(
  provider: Provider,
  model: string,
  usage: CanonicalUsage,
  options: { cacheTtlSeconds?: number | null; cacheStorageTokenHours?: number | null } = {},
): CostBreakdown {
  const providerCost = finiteNonNegative(usage.provider_reported_cost_usd);
  const input = finiteNonNegative(usage.input_tokens);
  const output = finiteNonNegative(usage.output_tokens);
  if (providerCost !== null) {
    return {
      pricing_version: PRICING_VERSION,
      cost_basis: "provider_reported",
      estimate_status: "estimated",
      input_cost_usd: null,
      output_cost_usd: null,
      cache_read_cost_usd: null,
      cache_creation_cost_usd: null,
      cache_storage_cost_usd: null,
      estimated_cost_usd: providerCost,
      estimated_savings_usd: null,
      unknown_reason: null,
    };
  }
  if (usage.usage_status === "missing" || (input === null && output === null)) {
    return {
      pricing_version: null,
      cost_basis: "none",
      estimate_status: "missing_usage",
      input_cost_usd: null,
      output_cost_usd: null,
      cache_read_cost_usd: null,
      cache_creation_cost_usd: null,
      cache_storage_cost_usd: null,
      estimated_cost_usd: null,
      estimated_savings_usd: null,
      unknown_reason: "usage_missing",
    };
  }

  const cacheRead = finiteNonNegative(usage.cache_read_tokens) ?? 0;
  const cacheCreation = finiteNonNegative(usage.cache_creation_tokens) ?? 0;
  const totalInput = (input ?? 0) + (provider === "anthropic" ? cacheRead + cacheCreation : 0);
  const price = lookupPrice(provider, model, totalInput);
  if (!price) {
    return {
      pricing_version: null,
      cost_basis: "none",
      estimate_status: "unknown_price",
      input_cost_usd: null,
      output_cost_usd: null,
      cache_read_cost_usd: null,
      cache_creation_cost_usd: null,
      cache_storage_cost_usd: null,
      estimated_cost_usd: null,
      estimated_savings_usd: null,
      unknown_reason: "model_price_unavailable",
    };
  }

  const rates = price.rates;
  const divisor = 1_000_000;
  const nonCachedInput = provider === "anthropic"
    ? input ?? 0
    : Math.max(0, (input ?? 0) - cacheRead - cacheCreation);
  const inputCost = nonCachedInput * rates.input / divisor;
  const outputCost = (output ?? 0) * rates.output / divisor;
  const cacheReadCost = cacheRead * (rates.cacheRead ?? rates.input) / divisor;
  let cacheWriteRate = rates.cacheWrite ?? rates.input;
  if ((options.cacheTtlSeconds ?? 0) >= 3600 && rates.cacheWrite1h !== undefined) cacheWriteRate = rates.cacheWrite1h;
  else if (rates.cacheWrite5m !== undefined) cacheWriteRate = rates.cacheWrite5m;
  const cacheCreationCost = cacheCreation * cacheWriteRate / divisor;
  const storageTokenHours = finiteNonNegative(options.cacheStorageTokenHours) ?? 0;
  const cacheStorageCost = storageTokenHours * (rates.cacheStoragePerMillionTokenHour ?? 0) / divisor;
  const baselineInputTokens = nonCachedInput + cacheRead + cacheCreation;
  const baseline = baselineInputTokens * rates.input / divisor;
  const actualInput = inputCost + cacheReadCost + cacheCreationCost;
  return {
    pricing_version: price.pricingVersion,
    cost_basis: "catalog",
    estimate_status: "estimated",
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    cache_read_cost_usd: cacheReadCost,
    cache_creation_cost_usd: cacheCreationCost,
    cache_storage_cost_usd: cacheStorageCost,
    estimated_cost_usd: actualInput + outputCost + cacheStorageCost,
    estimated_savings_usd: usage.cache_read_tokens === null && usage.cache_creation_tokens === null
      ? null
      : baseline - actualInput,
    unknown_reason: null,
  };
}

export function conservativeRequestCost(
  provider: Provider,
  model: string,
  inputTokenUpperBound: number,
  maxOutputTokens: number,
  options: { explicitCacheTtlSeconds?: number | null } = {},
): number | null {
  const price = lookupPrice(provider, model, inputTokenUpperBound);
  if (!price) return null;
  const explicitCacheHours = Math.max(0, Number(options.explicitCacheTtlSeconds || 0)) / 3600;
  const explicitCacheRate = explicitCacheHours > 0
    ? Math.max(price.rates.input, price.rates.cacheWrite ?? price.rates.input)
      + (price.rates.cacheRead ?? price.rates.input)
      + (price.rates.cacheStoragePerMillionTokenHour ?? 0) * explicitCacheHours
    : price.rates.input;
  return (inputTokenUpperBound * explicitCacheRate + maxOutputTokens * price.rates.output) / 1_000_000;
}
