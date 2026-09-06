import { describe, expect, it } from "vitest";

import { conservativeRequestCost, estimateUsageCost } from "../src/pricing-catalog";
import type { CanonicalUsage } from "../src/types";

function usage(values: Partial<CanonicalUsage>): CanonicalUsage {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    reasoning_tokens: null,
    provider_reported_cost_usd: null,
    cache_creation_5m_tokens: null,
    cache_creation_1h_tokens: null,
    cache_ttl_seconds: null,
    cache_status: "unreported",
    usage_status: "reported",
    ...values,
  };
}

describe("Phase 3 pricing catalog", () => {
  it("provider報告実コストをカタログ概算より優先する", () => {
    const result = estimateUsageCost("openrouter", "openai/gpt-5.4-nano", usage({
      input_tokens: 1000,
      output_tokens: 100,
      provider_reported_cost_usd: 0.00042,
    }));
    expect(result).toMatchObject({ cost_basis: "provider_reported", estimated_cost_usd: 0.00042 });
  });

  it("Anthropicの非cache入力・5分write・readを分けて計算する", () => {
    const result = estimateUsageCost("anthropic", "claude-haiku-4-5-20251001", usage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 1000,
      cache_creation_tokens: 500,
      cache_creation_5m_tokens: 500,
    }), { cacheTtlSeconds: 300 });
    expect(result.input_cost_usd).toBeCloseTo(0.0001);
    expect(result.cache_read_cost_usd).toBeCloseTo(0.0001);
    expect(result.cache_creation_cost_usd).toBeCloseTo(0.000625);
    expect(result.output_cost_usd).toBeCloseTo(0.00025);
    expect(result.estimated_cost_usd).toBeCloseTo(0.001075);
  });

  it("単価不明を0円へ変換しない", () => {
    const result = estimateUsageCost("xai", "unknown-model", usage({ input_tokens: 10, output_tokens: 5 }));
    expect(result).toMatchObject({ estimate_status: "unknown_price", estimated_cost_usd: null });
  });

  it("usage欠落を単価不明と区別する", () => {
    const result = estimateUsageCost("gemini", "gemini-2.5-flash-lite", usage({ usage_status: "missing" }));
    expect(result).toMatchObject({ estimate_status: "missing_usage", unknown_reason: "usage_missing" });
  });

  it("Gemini Flash-Liteのcache readを現行単価で計算する", () => {
    const result = estimateUsageCost("gemini", "gemini-2.5-flash-lite", usage({
      input_tokens: 3000,
      output_tokens: 10,
      cache_read_tokens: 2000,
      cache_creation_tokens: 0,
    }));
    expect(result.cache_read_cost_usd).toBeCloseTo(0.00005);
    expect(result.estimated_cost_usd).toBeCloseTo(0.000154);
  });

  it("Gemini 3.5 Flash-Liteを公式単価で計算する", () => {
    const result = estimateUsageCost("gemini", "gemini-3.5-flash-lite", usage({
      input_tokens: 1000,
      output_tokens: 256,
    }));
    expect(result.input_cost_usd).toBeCloseTo(0.0003);
    expect(result.output_cost_usd).toBeCloseTo(0.00064);
    expect(result.estimated_cost_usd).toBeCloseTo(0.00094);
  });

  it("Gemini 3 Flash Previewを料金確認済みとして計算する", () => {
    const result = estimateUsageCost("gemini", "gemini-3-flash-preview", usage({
      input_tokens: 1000,
      output_tokens: 256,
    }));
    expect(result).toMatchObject({
      pricing_version: "2026-09-04.1",
      cost_basis: "catalog",
      estimate_status: "estimated",
    });
    expect(result.input_cost_usd).toBeCloseTo(0.0005);
    expect(result.output_cost_usd).toBeCloseTo(0.000768);
    expect(result.estimated_cost_usd).toBeCloseTo(0.001268);
  });

  it("Gemini 3.5 Flash-Liteの0.01 USD保守予約境界を判定する", () => {
    const withinLimit = conservativeRequestCost("gemini", "gemini-3.5-flash-lite", 30_000, 256);
    const overLimit = conservativeRequestCost("gemini", "gemini-3.5-flash-lite", 32_000, 256);
    expect(withinLimit).toBeCloseTo(0.00964);
    expect(overLimit).toBeCloseTo(0.01024);
    expect(withinLimit!).toBeLessThan(0.01);
    expect(overLimit!).toBeGreaterThan(0.01);
  });

  it("xAI長文tierを保守的予算へ適用する", () => {
    const short = conservativeRequestCost("xai", "grok-4.3", 1000, 100);
    const long = conservativeRequestCost("xai", "grok-4.3", 140_000, 100);
    expect(short).toBeCloseTo(0.0015);
    expect(long).toBeCloseTo(0.3505);
  });

  it("Gemini明示cacheの作成・参照・TTL保管料を事前予約する", () => {
    const normal = conservativeRequestCost("gemini", "gemini-2.5-flash-lite", 1000, 100);
    const explicit = conservativeRequestCost(
      "gemini", "gemini-2.5-flash-lite", 1000, 100, { explicitCacheTtlSeconds: 3600 },
    );
    expect(normal).toBeCloseTo(0.00014);
    expect(explicit).toBeCloseTo(0.001165);
    expect(explicit!).toBeGreaterThan(normal!);
  });
});
