import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { validateLiveProvider } from "../src/live-validation";
import anthropicModels from "./fixtures/anthropic/models.json";
import anthropicStream from "./fixtures/anthropic/normal.sse?raw";
import geminiModels from "./fixtures/gemini/models.json";
import geminiStream from "./fixtures/gemini/normal.sse?raw";
import openaiModels from "./fixtures/openai/models.json";
import openaiStream from "./fixtures/openai/normal.sse?raw";
import openrouterModels from "./fixtures/openrouter/models.json";
import openrouterStream from "./fixtures/openrouter/normal.sse?raw";
import xaiModels from "./fixtures/xai/models.json";
import xaiStream from "./fixtures/xai/normal.sse?raw";

const MODELS = {
  gemini: geminiModels,
  openai: openaiModels,
  anthropic: anthropicModels,
  xai: xaiModels,
  openrouter: openrouterModels,
};

const STREAMS = {
  gemini: geminiStream,
  openai: openaiStream,
  anthropic: anthropicStream,
  xai: xaiStream,
  openrouter: openrouterStream,
};

function fakeFetcher(provider: keyof typeof MODELS, captures: Request[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    captures.push(request);
    const headers = { "Content-Type": request.method === "GET" ? "application/json" : "text/event-stream", "x-request-id": "safe-test-id" };
    if (request.method === "GET") return new Response(JSON.stringify(MODELS[provider]), { headers });
    return new Response(STREAMS[provider], { headers });
  }) as typeof fetch;
}

describe("Phase 0 live API validation guard", () => {
  for (const provider of ["gemini", "openai", "anthropic", "xai", "openrouter"] as const) {
    it(`${provider}は一覧1回と固定stream 3回だけ実行する`, async () => {
      const captures: Request[] = [];
      const result = await validateLiveProvider(
        { run_id: `vitest-${provider}`, provider, confirmation: "PHASE0_LIVE_API_APPROVED" },
        env,
        fakeFetcher(provider, captures),
      );

      expect(result.ok).toBe(true);
      expect(captures).toHaveLength(4);
      expect(captures.filter((request) => request.method === "GET")).toHaveLength(1);
      expect(captures.filter((request) => request.method === "POST")).toHaveLength(3);
      expect(result).not.toHaveProperty("text");
      expect(JSON.stringify(result)).not.toContain("PHASE0_OK");
      expect(result.estimated_maximum_usd).toBeLessThan(0.01);

      if (provider === "xai") {
        expect(captures[0]?.headers.get("Authorization")).toBe("Bearer phase0-xai-test-secret");
        expect(captures[0]?.headers.get("x-grok-conv-id")).toBe(`phase0-vitest-${provider}`);
      }

      for (const request of captures.filter((item) => item.method === "POST")) {
        const body = await request.clone().text();
        expect(body).toContain("PHASE0_OK");
        expect(body).toMatch(/max(?:_output_tokens|OutputTokens|_tokens)/);
        if (provider === "xai") expect(JSON.parse(body)).toMatchObject({ reasoning_effort: "none" });
      }
    });
  }

  it("同じrunとproviderを再実行しない", async () => {
    const captures: Request[] = [];
    const input = { run_id: "vitest-once", provider: "gemini", confirmation: "PHASE0_LIVE_API_APPROVED" };
    await validateLiveProvider(input, env, fakeFetcher("gemini", captures));
    await expect(validateLiveProvider(input, env, fakeFetcher("gemini", captures))).rejects.toThrow(
      "live_validation_already_attempted",
    );
    expect(captures).toHaveLength(4);
  });

  it("Anthropicの残高不足らしい生メッセージを返さない", async () => {
    const rawMessage = "Your credit balance is too low to access the Anthropic API";
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { type: "invalid_request_error", message: rawMessage } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const result = await validateLiveProvider(
      { run_id: "vitest-anthropic-credit", provider: "anthropic", confirmation: "PHASE0_LIVE_API_APPROVED" },
      env,
      fetcher,
    );
    expect(result).toMatchObject({
      ok: false,
      stage: "models",
      failure: {
        error: { category: "rate_limit", provider_code: "credit_balance_too_low", request_may_be_billed: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawMessage);
  });

  it("入力providerをallowlist外へ変更できない", async () => {
    await expect(
      validateLiveProvider(
        { run_id: "vitest-invalid", provider: "other", confirmation: "PHASE0_LIVE_API_APPROVED" },
        env,
      ),
    ).rejects.toThrow("invalid_live_validation_request");
  });
});
