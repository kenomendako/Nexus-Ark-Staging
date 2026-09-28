import { describe, expect, it } from "vitest";

import { normalizeModelList } from "../src/adapters";
import { normalizeLedgerContractEntry } from "../src/ledger-contract";
import type { Provider } from "../src/types";
import anthropicModels from "./fixtures/anthropic/models.json?raw";
import geminiModels from "./fixtures/gemini/models.json?raw";
import openaiModels from "./fixtures/openai/models.json?raw";
import openrouterModels from "./fixtures/openrouter/models.json?raw";
import xaiModels from "./fixtures/xai/models.json?raw";

const MODEL_FIXTURES: Record<Provider, string> = {
  gemini: geminiModels,
  openai: openaiModels,
  anthropic: anthropicModels,
  xai: xaiModels,
  openrouter: openrouterModels,
};

describe("model list and ledger contracts", () => {
  for (const provider of ["gemini", "openai", "anthropic", "xai", "openrouter"] satisfies Provider[]) {
    it(`${provider}のモデル一覧を共通契約へ変換する`, () => {
      const models = normalizeModelList(provider, JSON.parse(MODEL_FIXTURES[provider]));
      expect(models).toHaveLength(1);
      expect(models[0]?.provider).toBe(provider);
      expect(models[0]?.model_id).toContain("model-phase0");
    });
  }

  it("旧JSONL行を後方互換で読み取る", () => {
    expect(
      normalizeLedgerContractEntry({
        ts: "2026-07-15T00:00:00+09:00",
        provider: "openai",
        source: "chat",
        model: "model-phase0",
        cost: 0.001,
      }),
    ).toMatchObject({ source: "chat", known_cost_usd: 0.001, unknown_price_count: 0 });
  });

  it("旅行レシートの未知価格を0円へ変換しない", () => {
    expect(
      normalizeLedgerContractEntry({
        receipt_id: "receipt-phase0",
        occurred_at: "2026-07-15T00:00:00+09:00",
        provider: "xai",
        model_resolved: "model-phase0",
        estimate_status: "unknown_price",
      }),
    ).toMatchObject({ source: "travel", known_cost_usd: null, unknown_price_count: 1 });
  });
});
