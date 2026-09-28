import anthropicNormal from "./fixtures/anthropic/normal.sse?raw";
import geminiNormal from "./fixtures/gemini/normal.sse?raw";
import openaiNormal from "./fixtures/openai/normal.sse?raw";
import openrouterFallback from "./fixtures/openrouter/fallback_violation.sse?raw";
import openrouterNormal from "./fixtures/openrouter/normal.sse?raw";
import xaiNormal from "./fixtures/xai/normal.sse?raw";
import type { Provider } from "../src/types";

const NORMAL_FIXTURES: Record<Provider, string> = {
  gemini: geminiNormal,
  openai: openaiNormal,
  anthropic: anthropicNormal,
  xai: xaiNormal,
  openrouter: openrouterNormal,
};

export class MockProvider {
  calls = 0;

  async stream(provider: Provider, scenario: "normal" | "interrupted" | "fallback_violation" = "normal"): Promise<string> {
    this.calls += 1;
    const fixture = scenario === "fallback_violation" ? openrouterFallback : NORMAL_FIXTURES[provider];
    if (scenario === "interrupted") {
      return fixture.replace(/(?:event: response\.completed[\s\S]*)|(?:event: message_stop[\s\S]*)|(?:data: \[DONE\][\s\S]*)|(?:,"finishReason":"STOP"\}\]\})/g, "");
    }
    return fixture;
  }
}
