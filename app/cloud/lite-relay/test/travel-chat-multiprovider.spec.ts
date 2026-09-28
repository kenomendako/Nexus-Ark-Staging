import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { buildSignedBundle, registerSnapshot } from "../src/phase1";
import { changePersonaRoute, upsertProviderProfile } from "../src/phase2-routing";
import { getEventsAfterCursor, getMessageRequest } from "../src/storage";
import { streamTravelMessage } from "../src/travel-chat";
import type { Provider } from "../src/types";
import anthropicNormal from "./fixtures/anthropic/normal.sse?raw";
import openaiNormal from "./fixtures/openai/normal.sse?raw";
import openrouterFallback from "./fixtures/openrouter/fallback_violation.sse?raw";
import openrouterNormal from "./fixtures/openrouter/normal.sse?raw";
import xaiNormal from "./fixtures/xai/normal.sse?raw";
import geminiNormal from "./fixtures/gemini/normal.sse?raw";

interface Case {
  provider: Exclude<Provider, "gemini">;
  profileId: string;
  binding: "OPENAI_PERSONAL_1" | "ANTHROPIC_PERSONAL_1" | "XAI_PERSONAL_1" | "OPENROUTER_PERSONAL_1";
  baseUrlId: string;
  model: string;
  fixture: string;
  host: string;
  secretHeader: string;
  secretValue: string;
}

const CASES: Case[] = [
  {
    provider: "openai",
    profileId: "openai-phase2-chat",
    binding: "OPENAI_PERSONAL_1",
    baseUrlId: "openai-official",
    model: "model-phase0",
    fixture: openaiNormal,
    host: "api.openai.com",
    secretHeader: "authorization",
    secretValue: "Bearer phase0-openai-test-secret",
  },
  {
    provider: "anthropic",
    profileId: "anthropic-phase2-chat",
    binding: "ANTHROPIC_PERSONAL_1",
    baseUrlId: "anthropic-official",
    model: "model-phase0",
    fixture: anthropicNormal,
    host: "api.anthropic.com",
    secretHeader: "x-api-key",
    secretValue: "phase0-anthropic-test-secret",
  },
  {
    provider: "xai",
    profileId: "xai-phase2-chat",
    binding: "XAI_PERSONAL_1",
    baseUrlId: "xai-official",
    model: "model-phase0",
    fixture: xaiNormal,
    host: "api.x.ai",
    secretHeader: "authorization",
    secretValue: "Bearer phase0-xai-test-secret",
  },
  {
    provider: "openrouter",
    profileId: "openrouter-phase2-chat",
    binding: "OPENROUTER_PERSONAL_1",
    baseUrlId: "openrouter-official",
    model: "requested/model-phase0",
    fixture: openrouterNormal,
    host: "openrouter.ai",
    secretHeader: "authorization",
    secretValue: "Bearer phase0-openrouter-test-secret",
  },
];

function snapshot(suffix: string, profileId: string, model: string) {
  return {
    schema_version: 2,
    travel_session_id: `multi-chat-${suffix}`,
    persona_id: `multi-persona-${suffix}`,
    persona_display_name: "Multi-provider Persona",
    system_prompt: "Synthetic system prompt.",
    core_memory: "Synthetic core memory.",
    episodic_summary: "",
    recent_messages: [{ role: "assistant", content: "Synthetic earlier answer." }],
    initial_route: { credential_profile_id: profileId, model_id: model },
    retention_days: 7,
    created_at: "2026-07-16T02:00:00.000Z",
  };
}

function provider(raw: string, captures: Array<{ url: string; headers: Headers; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captures.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(raw, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
}

async function createProfile(testCase: Case): Promise<void> {
  await upsertProviderProfile(
    env.DB,
    testCase.profileId,
    {
      display_name: `${testCase.provider} Phase 2 chat`,
      provider: testCase.provider,
      secret_binding_id: testCase.binding,
      allowed_base_url_id: testCase.baseUrlId,
      enabled: true,
    },
    "2026-07-16T02:00:00.000Z",
  );
}

describe("Phase 2 multi-provider travel chat", () => {
  for (const testCase of CASES) {
    it(`${testCase.provider}公式APIへ固定routeで送信しatomic確定する`, async () => {
      await createProfile(testCase);
      const suffix = `${testCase.provider}-${crypto.randomUUID()}`;
      const raw = snapshot(suffix, testCase.profileId, testCase.model);
      await registerSnapshot(env.DB, raw);
      const captures: Array<{ url: string; headers: Headers; body: string }> = [];
      const clientMessageId = `multi_${testCase.provider}_${crypto.randomUUID()}`;

      const response = await streamTravelMessage(
        env.DB,
        env,
        raw.travel_session_id,
        { client_message_id: clientMessageId, message: "Synthetic current question." },
        provider(testCase.fixture, captures),
      );
      const responseBody = await response.text();

      expect(response.status).toBe(200);
      expect(responseBody).toContain("response.committed");
      expect(responseBody).toContain(`\"provider\":\"${testCase.provider}\"`);
      expect(captures).toHaveLength(1);
      expect(new URL(captures[0]!.url).host).toBe(testCase.host);
      expect(captures[0]!.headers.get(testCase.secretHeader)).toBe(testCase.secretValue);
      expect(captures[0]!.body).not.toContain(testCase.secretValue.replace(/^Bearer /, ""));
      expect(captures[0]!.body).toContain("Synthetic system prompt.");
      expect(captures[0]!.body).toContain("Synthetic current question.");

      const requestBody = JSON.parse(captures[0]!.body) as Record<string, unknown>;
      expect(requestBody.model).toBe(testCase.model);
      expect(requestBody.stream).toBe(true);
      if (testCase.provider === "anthropic") {
        expect(requestBody.max_tokens).toBe(16_384);
      } else {
        expect(requestBody).not.toHaveProperty("max_tokens");
        expect(requestBody).not.toHaveProperty("max_output_tokens");
      }
      if (testCase.provider === "openai") expect(requestBody.store).toBe(false);
      if (testCase.provider === "anthropic") {
        expect(captures[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
      }
      if (testCase.provider === "xai") {
        expect(captures[0]!.headers.get("x-grok-conv-id")).toBe(raw.travel_session_id);
      }
      if (testCase.provider === "openrouter") {
        expect(requestBody.session_id).toBe(raw.travel_session_id);
        expect(requestBody.provider).toEqual({ allow_fallbacks: false });
      }

      const events = await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0);
      expect(events.events.map((event) => [event.type, event.route_epoch])).toEqual([
        ["user_message", 0],
        ["assistant_message", 0],
      ]);
      expect(events.events[1]).toMatchObject({ provider: testCase.provider, model_requested: testCase.model });
      expect(await getMessageRequest(env.DB, clientMessageId)).toMatchObject({
        status: "completed",
        provider: testCase.provider,
        credential_profile_id: testCase.profileId,
        model_requested: testCase.model,
        route_epoch: 0,
      });
      const receipt = await env.DB
        .prepare(
          `SELECT provider, gateway, credential_profile_id, model_requested, model_resolved, upstream_provider, route_epoch
           FROM usage_receipts WHERE travel_session_id = ?`,
        )
        .bind(raw.travel_session_id)
        .first<Record<string, unknown>>();
      expect(receipt).toMatchObject({
        provider: testCase.provider,
        gateway: testCase.provider === "openrouter" ? "openrouter" : null,
        credential_profile_id: testCase.profileId,
        model_requested: testCase.model,
        model_resolved: testCase.provider === "openrouter" ? "resolved/model-phase0" : "model-phase0",
        upstream_provider: testCase.provider === "openrouter" ? "SyntheticUpstream" : null,
        route_epoch: 0,
      });
    });
  }

  it("OpenRouterのunexpected fallbackをfailed_knownとして保存し会話を確定しない", async () => {
    const testCase = CASES.find((item) => item.provider === "openrouter")!;
    await createProfile(testCase);
    const suffix = `fallback-${crypto.randomUUID()}`;
    const raw = snapshot(suffix, testCase.profileId, testCase.model);
    await registerSnapshot(env.DB, raw);
    const captures: Array<{ url: string; headers: Headers; body: string }> = [];
    const clientMessageId = `fallback_${crypto.randomUUID()}`;

    const response = await streamTravelMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: clientMessageId, message: "Synthetic fallback request." },
      provider(openrouterFallback, captures),
    );
    const responseBody = await response.text();

    expect(responseBody).toContain("禁止されたフォールバック");
    expect(responseBody).not.toContain("response.committed");
    expect((await getMessageRequest(env.DB, clientMessageId))?.status).toBe("failed_known");
    expect((await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0)).events).toEqual([]);
    expect(
      await env.DB
        .prepare("SELECT receipt_id FROM usage_receipts WHERE travel_session_id = ?")
        .bind(raw.travel_session_id)
        .first(),
    ).toBeNull();
    expect(captures).toHaveLength(1);
  });

  it("1セッションでGemini→OpenAI→xAIへ切り替えてsequenceとepochを維持する", async () => {
    const openai = CASES.find((item) => item.provider === "openai")!;
    const xai = CASES.find((item) => item.provider === "xai")!;
    await createProfile(openai);
    await createProfile(xai);
    const suffix = `three-routes-${crypto.randomUUID()}`;
    const raw = snapshot(suffix, "gemini-personal-1", "model-phase1");
    await registerSnapshot(env.DB, raw);
    const captures: Array<{ url: string; headers: Headers; body: string }> = [];
    const send = async (label: string, fixture: string) => {
      const response = await streamTravelMessage(
        env.DB,
        env,
        raw.travel_session_id,
        { client_message_id: `${label}_${crypto.randomUUID()}`, message: `Synthetic ${label} question.` },
        provider(fixture, captures),
      );
      expect(await response.text()).toContain("response.committed");
    };

    await send("gemini", geminiNormal);
    await changePersonaRoute(
      env.DB,
      raw.travel_session_id,
      { route_change_id: `to_openai_${crypto.randomUUID()}`, credential_profile_id: openai.profileId, model_id: openai.model },
      "2026-07-16T03:01:00.000Z",
    );
    await send("openai", openaiNormal);
    await changePersonaRoute(
      env.DB,
      raw.travel_session_id,
      { route_change_id: `to_xai_${crypto.randomUUID()}`, credential_profile_id: xai.profileId, model_id: xai.model },
      "2026-07-16T03:02:00.000Z",
    );
    await send("xai", xaiNormal);

    const events = await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0);
    expect(events.missing_sequences).toEqual([]);
    expect(events.events.map((event) => [event.sequence_no, event.type, event.provider, event.route_epoch])).toEqual([
      [1, "user_message", null, 0],
      [2, "assistant_message", "gemini", 0],
      [3, "route_changed", "openai", 1],
      [4, "user_message", null, 1],
      [5, "assistant_message", "openai", 1],
      [6, "route_changed", "xai", 2],
      [7, "user_message", null, 2],
      [8, "assistant_message", "xai", 2],
    ]);
    const receipts = await env.DB
      .prepare(
        `SELECT r.provider, r.route_epoch, r.model_requested FROM usage_receipts r
         JOIN travel_events e ON e.event_id = r.event_id
         WHERE r.travel_session_id = ? ORDER BY e.sequence_no ASC`,
      )
      .bind(raw.travel_session_id)
      .all<Record<string, unknown>>();
    expect(receipts.results.map((item) => [item.provider, item.route_epoch])).toEqual([
      ["gemini", 0],
      ["openai", 1],
      ["xai", 2],
    ]);
    expect(captures.map((item) => new URL(item.url).host)).toEqual([
      "generativelanguage.googleapis.com",
      "api.openai.com",
      "api.x.ai",
    ]);
    const bundle = await buildSignedBundle(env.DB, raw.travel_session_id, "synthetic-signing-key", "2026-07-16T04:00:00.000Z");
    expect(bundle.payload.schema_version).toBe(2);
    expect(bundle.payload.session.initial_route).toEqual({
      credential_profile_id: "gemini-personal-1",
      provider: "gemini",
      model_id: "model-phase1",
      route_epoch: 0,
    });
    expect(bundle.payload.session.final_route).toEqual({
      credential_profile_id: xai.profileId,
      provider: "xai",
      model_id: xai.model,
      route_epoch: 2,
    });
    expect(bundle.payload.events.map((event: any) => [event.type, event.route_epoch])).toEqual([
      ["user_message", 0],
      ["assistant_message", 0],
      ["route_changed", 1],
      ["user_message", 1],
      ["assistant_message", 1],
      ["route_changed", 2],
      ["user_message", 2],
      ["assistant_message", 2],
    ]);
    expect(bundle.payload.receipts.map((receipt: any) => [receipt.provider, receipt.route_epoch])).toEqual([
      ["gemini", 0],
      ["openai", 1],
      ["xai", 2],
    ]);
  });
});
