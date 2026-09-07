import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { registerSnapshot } from "../src/phase1";
import { getEventsAfterCursor, getMessageRequest, markProviderStarted, reserveMessage } from "../src/storage";
import { streamGeminiMessage } from "../src/travel-chat";
import geminiNormal from "./fixtures/gemini/normal.sse?raw";

function snapshot(suffix: string) {
  return {
    schema_version: 1,
    travel_session_id: `chat-session-${suffix}`,
    persona_id: `chat-persona-${suffix}`,
    persona_display_name: "Chat Persona",
    system_prompt: "Synthetic system prompt.",
    core_memory: "Synthetic memory.",
    episodic_summary: "",
    recent_messages: [{ role: "user", content: "Earlier synthetic message" }],
    model_id: "model-phase1",
    retention_days: 7,
    created_at: "2026-07-15T09:00:00.000Z",
  };
}

function provider(raw: string, captures: Array<Record<string, unknown>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captures.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(raw, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
}

function rejectedProvider(status: number): typeof fetch {
  return (async () => new Response("synthetic raw provider error", { status })) as typeof fetch;
}

describe("Phase 1 Gemini travel chat", () => {
  it("SSE応答後にuser＋assistant＋receiptをatomic確定する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const captures: Array<Record<string, unknown>> = [];
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `client_${suffix}`, message: "Synthetic user message" },
      provider(geminiNormal, captures),
    );
    const body = await response.text();
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(body).toContain("response.text.delta");
    expect(body).toContain("response.committed");
    expect(captures).toHaveLength(1);
    expect((captures[0]?.headers as Headers).get("x-goog-api-key")).toBe("phase0-gemini-test-secret");
    expect(String(captures[0]?.url)).toContain(encodeURIComponent(raw.model_id));
    expect(String(captures[0]?.body)).toContain("Synthetic system prompt.");
    const providerBody = JSON.parse(String(captures[0]?.body)) as Record<string, any>;
    expect(providerBody.generationConfig).not.toHaveProperty("maxOutputTokens");

    const events = await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0);
    expect(events.events.map((event) => [event.sequence_no, event.type, event.content])).toEqual([
      [1, "user_message", "Synthetic user message"],
      [2, "assistant_message", "PHASE0_OK"],
    ]);
    expect((await getMessageRequest(env.DB, `client_${suffix}`))?.status).toBe("completed");
    expect(
      await env.DB
        .prepare(
          `SELECT provider_terminal_code, provider_stream_record_count, provider_text_chars,
                  provider_usage_status, provider_unknown_event_count
           FROM message_requests WHERE client_message_id = ?`,
        )
        .bind(`client_${suffix}`)
        .first(),
    ).toMatchObject({
      provider_terminal_code: "STOP",
      provider_stream_record_count: 2,
      provider_text_chars: 9,
      provider_usage_status: "reported",
      provider_unknown_event_count: 0,
    });
    const receipt = await env.DB
      .prepare("SELECT signature FROM usage_receipts WHERE travel_session_id = ?")
      .bind(raw.travel_session_id)
      .first<{ signature: string }>();
    expect(receipt?.signature).toBeTruthy();
    expect(receipt?.signature).not.toBe("unsigned");
  });

  it("同じclient_message_idの再送でproviderを再呼出ししない", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const captures: Array<Record<string, unknown>> = [];
    const input = { client_message_id: `duplicate_${suffix}`, message: "Synthetic duplicate" };
    const first = await streamGeminiMessage(env.DB, env, raw.travel_session_id, input, provider(geminiNormal, captures));
    await first.text();
    const second = await streamGeminiMessage(env.DB, env, raw.travel_session_id, input, provider(geminiNormal, captures));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "message_already_reserved", status: "completed" });
    expect(captures).toHaveLength(1);
  });

  it("同じsessionの別タブ同時送信をprovider呼出し前に拒否する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    await reserveMessage(env.DB, {
      clientMessageId: `active_${suffix}`,
      travelSessionId: raw.travel_session_id,
      personaId: raw.persona_id,
      provider: "gemini",
      modelRequested: raw.model_id,
      reservedAt: new Date().toISOString(),
    });
    await markProviderStarted(env.DB, `active_${suffix}`, new Date().toISOString());
    const captures: Array<Record<string, unknown>> = [];
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `other_${suffix}`, message: "Synthetic concurrent send" },
      provider(geminiNormal, captures),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "session_message_in_progress" });
    expect(captures).toHaveLength(0);
  });

  it("終端のないprovider streamをpartialにし会話eventを確定しない", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const interrupted = geminiNormal.replace('"finishReason":"STOP"', '"finishReason":""');
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `partial_${suffix}`, message: "Synthetic partial" },
      provider(interrupted, []),
    );
    const body = await response.text();
    expect(body).toContain("stream_interrupted");
    expect((await getMessageRequest(env.DB, `partial_${suffix}`))?.status).toBe("partial");
    expect(
      await env.DB
        .prepare("SELECT provider_terminal_code FROM message_requests WHERE client_message_id = ?")
        .bind(`partial_${suffix}`)
        .first(),
    ).toMatchObject({ provider_terminal_code: null });
    expect((await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0)).events).toHaveLength(0);
  });

  it("モデルの最大長到達を通信切断と区別して案内する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const limited = geminiNormal.replace('"finishReason":"STOP"', '"finishReason":"MAX_TOKENS"');
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `limited_${suffix}`, message: "Synthetic long response" },
      provider(limited, []),
    );
    const body = await response.text();
    expect(body).toContain("output_limit");
    expect(body).toContain("モデルの最大長に達しました");
    expect(body).not.toContain("応答が途中で切断されました");
    expect((await getMessageRequest(env.DB, `limited_${suffix}`))?.status).toBe("partial");
  });

  it("Geminiの既知content拒否をfailed_knownにし会話eventを確定しない", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const blocked =
      'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":12}}\n\n';
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `blocked_${suffix}`, message: "Synthetic blocked" },
      provider(blocked, []),
    );
    const body = await response.text();
    expect(body).toContain("確定応答として返しませんでした");
    expect((await getMessageRequest(env.DB, `blocked_${suffix}`))?.status).toBe("failed_known");
    expect(
      await env.DB
        .prepare("SELECT provider_terminal_code FROM message_requests WHERE client_message_id = ?")
        .bind(`blocked_${suffix}`)
        .first(),
    ).toMatchObject({ provider_terminal_code: "prompt_SAFETY" });
    expect((await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0)).events).toHaveLength(0);
  });

  it("GeminiのHTTP拒否を本文非保持の安定エラーへ変換する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await registerSnapshot(env.DB, raw);
    const response = await streamGeminiMessage(
      env.DB,
      env,
      raw.travel_session_id,
      { client_message_id: `rate_${suffix}`, message: "Synthetic rate limit" },
      rejectedProvider(429),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "provider_rate_limited",
      safe_message_ja: "Geminiの一時的な利用上限に達しました。時間を置き、同じ内容を自動再送しないでください。",
    });
    expect(
      await env.DB
        .prepare(
          `SELECT status, provider_http_status, provider_error_code
           FROM message_requests WHERE client_message_id = ?`,
        )
        .bind(`rate_${suffix}`)
        .first(),
    ).toMatchObject({
      status: "failed_known",
      provider_http_status: 429,
      provider_error_code: "provider_rate_limited",
    });
    expect((await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0)).events).toHaveLength(0);
  });
});
