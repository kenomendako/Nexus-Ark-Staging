import { describe, expect, it } from "vitest";

import { buildOpenRouterProviderPolicy, normalizeProviderStream } from "../src/adapters";
import type { Provider } from "../src/types";
import { MockProvider } from "./mock-provider";

describe("provider stream contracts", () => {
  for (const provider of ["gemini", "openai", "anthropic", "xai", "openrouter"] satisfies Provider[]) {
    it(`${provider}の正常fixtureを共通契約へ正規化する`, async () => {
      const mock = new MockProvider();
      const raw = await mock.stream(provider);
      const result = normalizeProviderStream(provider, raw, "requested/model-phase0");

      expect(result.terminal_status).toBe("completed");
      expect(result.text).toBe("PHASE0_OK");
      expect(result.usage.usage_status).toBe("reported");
      expect(result.usage.output_tokens).toBeGreaterThan(0);
      expect(result.events.at(-1)?.type).toBe("response.committed");
    });
  }

  it("終端のないstreamはpartialになり確定されない", async () => {
    const mock = new MockProvider();
    const raw = await mock.stream("openai", "interrupted");
    const result = normalizeProviderStream("openai", raw, "model-phase0");

    expect(result.terminal_status).toBe("partial");
    expect(result.events.some((event) => event.type === "response.committed")).toBe(false);
    expect(result.events.at(-1)?.type).toBe("response.partial");
  });

  it("Geminiのprompt blockと安全停止を既知拒否として確定しない", () => {
    const promptBlocked = normalizeProviderStream(
      "gemini",
      'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":12}}\n\n',
      "model-phase0",
    );
    const candidateBlocked = normalizeProviderStream(
      "gemini",
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"RECITATION"}]}\n\n',
      "model-phase0",
    );

    for (const result of [promptBlocked, candidateBlocked]) {
      expect(result.terminal_status).toBe("failed_known");
      expect(result.events.some((event) => event.type === "response.committed")).toBe(false);
      expect(result.events.some((event) => event.type === "response.error")).toBe(true);
    }
  });

  it("GeminiのMAX_TOKENSは上限到達として部分応答にする", () => {
    const result = normalizeProviderStream(
      "gemini",
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
      "model-phase0",
    );
    expect(result.terminal_status).toBe("partial");
    expect(result.events.some((event) => event.type === "response.committed")).toBe(false);
    expect(result.events.at(-1)).toEqual({
      schema_version: 1,
      type: "response.partial",
      reason: "max_output_tokens",
    });
  });

  it("xAIの累積usageは最後の値を採用して二重加算しない", async () => {
    const raw = await new MockProvider().stream("xai");
    const result = normalizeProviderStream("xai", raw, "model-phase0");
    expect(result.usage.output_tokens).toBe(3);
    expect(result.usage.cache_read_tokens).toBe(6);
    expect(result.usage.provider_reported_cost_usd).toBe(0.0000136);
  });

  it("OpenRouterは要求・解決モデル、上流、実costを分離する", async () => {
    const raw = await new MockProvider().stream("openrouter");
    const result = normalizeProviderStream("openrouter", raw, "requested/model-phase0");
    expect(result.model_requested).toBe("requested/model-phase0");
    expect(result.model_resolved).toBe("resolved/model-phase0");
    expect(result.upstream_provider).toBe("SyntheticUpstream");
    expect(result.usage.provider_reported_cost_usd).toBe(0.00012);
    expect(result.usage.cache_creation_tokens).toBe(2);
  });

  it("OpenRouter provider policyはfallbackを常に無効化する", () => {
    expect(buildOpenRouterProviderPolicy()).toEqual({ allow_fallbacks: false });
    expect(buildOpenRouterProviderPolicy(["SyntheticUpstream"])).toEqual({
      allow_fallbacks: false,
      only: ["SyntheticUpstream"],
    });
  });

  it("OpenRouter metadataでfallback実行を契約違反として検出する", async () => {
    const raw = await new MockProvider().stream("openrouter", "fallback_violation");
    const result = normalizeProviderStream("openrouter", raw, "requested/model-phase0");
    expect(result.routing_violation).toBe("unexpected_fallback");
  });

  it("stream内の既知エラーを安全な共通エラーへ変換する", () => {
    const raw = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"raw detail"}}\n\n';
    const result = normalizeProviderStream("anthropic", raw, "model-phase0");
    const error = result.events.find((event) => event.type === "response.error");
    expect(result.terminal_status).toBe("failed_known");
    expect(error).toMatchObject({
      type: "response.error",
      error: { category: "rate_limit", safe_message_ja: "プロバイダの利用上限に達しました。" },
    });
    expect(JSON.stringify(error)).not.toContain("raw detail");
  });
});
