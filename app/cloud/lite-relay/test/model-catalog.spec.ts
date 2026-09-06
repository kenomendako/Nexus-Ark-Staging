import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listModelsForProfile } from "../src/model-catalog";
import { upsertProviderProfile } from "../src/phase2-routing";
import type { Provider } from "../src/types";
import anthropicModels from "./fixtures/anthropic/models.json";
import geminiModels from "./fixtures/gemini/models.json";
import openrouterModels from "./fixtures/openrouter/models.json";
import xaiModels from "./fixtures/xai/models.json";

interface ProfileCase {
  provider: Provider;
  profileId: string;
  binding: string;
  baseUrlId: string;
  payload: unknown;
  expectedHost: string;
  secretHeader: string;
}

const CASES: ProfileCase[] = [
  {
    provider: "gemini",
    profileId: "gemini-personal-1",
    binding: "GEMINI_PERSONAL_1",
    baseUrlId: "gemini-official",
    payload: {
      models: [
        ...geminiModels.models,
        {
          name: "models/gemini-3.5-flash-lite",
          displayName: "Gemini 3.5 Flash-Lite",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
      ],
    },
    expectedHost: "generativelanguage.googleapis.com",
    secretHeader: "x-goog-api-key",
  },
  {
    provider: "openai",
    profileId: "openai-model-list",
    binding: "OPENAI_PERSONAL_1",
    baseUrlId: "openai-official",
    payload: {
      data: [
        { id: "gpt-synthetic", object: "model" },
        { id: "text-embedding-synthetic", object: "model" },
        { id: "unknown-synthetic", object: "model" },
      ],
    },
    expectedHost: "api.openai.com",
    secretHeader: "authorization",
  },
  {
    provider: "anthropic",
    profileId: "anthropic-model-list",
    binding: "ANTHROPIC_PERSONAL_1",
    baseUrlId: "anthropic-official",
    payload: anthropicModels,
    expectedHost: "api.anthropic.com",
    secretHeader: "x-api-key",
  },
  {
    provider: "xai",
    profileId: "xai-model-list",
    binding: "XAI_PERSONAL_1",
    baseUrlId: "xai-official",
    payload: xaiModels,
    expectedHost: "api.x.ai",
    secretHeader: "authorization",
  },
  {
    provider: "openrouter",
    profileId: "openrouter-model-list",
    binding: "OPENROUTER_PERSONAL_1",
    baseUrlId: "openrouter-official",
    payload: openrouterModels,
    expectedHost: "openrouter.ai",
    secretHeader: "authorization",
  },
];

async function profile(item: ProfileCase): Promise<void> {
  await upsertProviderProfile(
    env.DB,
    item.profileId,
    {
      display_name: `${item.provider} model list`,
      provider: item.provider,
      secret_binding_id: item.binding,
      allowed_base_url_id: item.baseUrlId,
    },
    "2026-07-16T03:00:00.000Z",
  );
}

describe("Phase 2 profile model catalog", () => {
  for (const item of CASES) {
    it(`${item.provider}公式一覧を能力付き安全モデルへ変換する`, async () => {
      await profile(item);
      const captures: Array<{ url: string; headers: Headers }> = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captures.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json(item.payload);
      }) as typeof fetch;
      const result = await listModelsForProfile(
        env.DB,
        env.MODEL_CATALOG_CACHE,
        env,
        item.profileId,
        true,
        fetcher,
        new Date("2026-07-16T03:00:00.000Z"),
      );

      expect(result.source).toBe("live");
      expect(result.provider).toBe(item.provider);
      expect(captures).toHaveLength(1);
      expect(new URL(captures[0]!.url).host).toBe(item.expectedHost);
      expect(captures[0]!.headers.get(item.secretHeader)).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("phase0-");
      expect(result.models.some((model) => model.available)).toBe(true);
      expect(result.models.every((model) => typeof model.pricing_known === "boolean")).toBe(true);
      if (item.provider === "gemini") {
        expect(result.models.find((model) => model.model_id === "gemini-3.5-flash-lite")).toMatchObject({
          available: true,
          pricing_known: true,
        });
      }
      if (item.provider === "openai") {
        expect(result.models.find((model) => model.model_id === "gpt-synthetic")).toMatchObject({
          available: true,
          streaming: true,
        });
        expect(result.models.find((model) => model.model_id === "text-embedding-synthetic")).toMatchObject({
          available: false,
          unavailable_reason: "not_text_chat_capable",
        });
        expect(result.models.find((model) => model.model_id === "unknown-synthetic")).toMatchObject({
          available: false,
          unavailable_reason: "capability_unverified",
          pricing_known: false,
        });
      }
    });
  }

  it("5分fresh cacheを再利用し更新障害時は1時間以内のstaleへ限定fallbackする", async () => {
    const item = CASES.find((entry) => entry.provider === "xai")!;
    await profile(item);
    let calls = 0;
    const success = (async () => {
      calls += 1;
      return Response.json(item.payload);
    }) as typeof fetch;
    const base = new Date("2026-07-16T03:00:00.000Z");
    expect(
      (await listModelsForProfile(env.DB, env.MODEL_CATALOG_CACHE, env, item.profileId, true, success, base)).source,
    ).toBe("live");
    expect(
      (
        await listModelsForProfile(
          env.DB,
          env.MODEL_CATALOG_CACHE,
          env,
          item.profileId,
          false,
          (() => { throw new Error("must_not_fetch"); }) as typeof fetch,
          new Date(base.getTime() + 4 * 60_000),
        )
      ).source,
    ).toBe("cache");
    expect(calls).toBe(1);

    const rejected = (async () => new Response("raw provider detail", { status: 503 })) as typeof fetch;
    expect(
      (
        await listModelsForProfile(
          env.DB,
          env.MODEL_CATALOG_CACHE,
          env,
          item.profileId,
          true,
          rejected,
          new Date(base.getTime() + 30 * 60_000),
        )
      ).source,
    ).toBe("stale");
    await expect(
      listModelsForProfile(
        env.DB,
        env.MODEL_CATALOG_CACHE,
        env,
        item.profileId,
        true,
        rejected,
        new Date(base.getTime() + 61 * 60_000),
      ),
    ).rejects.toThrow("model_catalog_unavailable");
  });

  it("KV読書き障害時も公式一覧のlive結果を返す", async () => {
    const item = CASES.find((entry) => entry.provider === "anthropic")!;
    await profile(item);
    const brokenCache = {
      get: async () => { throw new Error("synthetic_kv_read_failure"); },
      put: async () => { throw new Error("synthetic_kv_write_failure"); },
    } as unknown as KVNamespace;
    const result = await listModelsForProfile(
      env.DB,
      brokenCache,
      env,
      item.profileId,
      false,
      (async () => Response.json(item.payload)) as typeof fetch,
      new Date("2026-07-16T03:00:00.000Z"),
    );
    expect(result.source).toBe("live");
    expect(result.models[0]).toMatchObject({ available: true, streaming: true });
  });
});
