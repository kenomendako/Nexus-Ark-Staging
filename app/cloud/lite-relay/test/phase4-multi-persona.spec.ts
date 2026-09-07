import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { closeSession, getCurrentSession, registerSnapshot, validateSnapshot } from "../src/phase1";
import { getUsageSummary } from "../src/budget";
import { upsertProviderProfile } from "../src/phase2-routing";
import { getEventsAfterCursor, getMessageRequest } from "../src/storage";
import { streamTravelMessage } from "../src/travel-chat";
import { acknowledgeReturn, buildSignedReturnChunk, emergencyReclaimPersona, startReturn } from "../src/phase4-return";
import geminiNormal from "./fixtures/gemini/normal.sse?raw";
import openaiNormal from "./fixtures/openai/normal.sse?raw";
import xaiNormal from "./fixtures/xai/normal.sse?raw";

function snapshot(suffix: string) {
  return {
    schema_version: 4 as const,
    travel_session_id: `phase4-${suffix}`,
    retention_days: 7 as const,
    session_budget: {
      daily_limit_usd: 1, session_limit_usd: 1, warning_ratio: 0.8,
      allow_unknown_price: false, max_output_tokens: 2048, timezone: "Asia/Tokyo",
    },
    personas: ["a", "b", "c"].map((name, index) => ({
      persona_id: `persona-${name}-${suffix}`,
      persona_display_name: `Persona ${name.toUpperCase()}`,
      presence_mode: index === 2 ? "parallel" as const : "exclusive" as const,
      system_prompt: `System ${name}`, core_memory: "core", episodic_summary: "",
      recent_messages: [] as Array<{ role: "user" | "assistant"; content: string }>,
      home_anchor: { created_at: "2026-07-16T00:00:00Z", log_tail_hash: `anchor-${name}` },
      initial_route: { credential_profile_id: "gemini-personal-1", model_id: `model-${name}` },
      budget: { daily_limit_usd: 0.5, session_limit_usd: 0.5, max_output_tokens: 1024 },
      cache_policy: "auto" as const,
    })),
    created_at: "2026-07-16T00:00:00Z",
  };
}

describe("Phase 4 multi persona snapshot", () => {
  it("v4を検証し重複・上限超過・秘密情報を拒否する", () => {
    const raw = snapshot(crypto.randomUUID());
    expect(validateSnapshot(raw)).toMatchObject({ schema_version: 4, personas: raw.personas });
    expect(() => validateSnapshot({ ...raw, personas: [...raw.personas, raw.personas[0]] })).toThrow("invalid_snapshot");
    expect(() => validateSnapshot({ ...raw, personas: [raw.personas[0], raw.personas[0]] })).toThrow("duplicate_persona");
    expect(() => validateSnapshot({ ...raw, personas: [{ ...raw.personas[0], system_prompt: "sk-abcdefghijklmnopqrstuvwxyz" }] }))
      .toThrow("snapshot_contains_secret");
  });

  it("3personaをsnapshot・route・現在セッションへ分離保存する", async () => {
    const raw = snapshot(crypto.randomUUID());
    raw.personas[0]!.recent_messages = [{ role: "user", content: "before departure" }];
    await registerSnapshot(env.DB, raw);
    const personas = await env.DB.prepare(
      "SELECT persona_id, presence_mode FROM travel_personas WHERE travel_session_id = ? ORDER BY persona_id",
    ).bind(raw.travel_session_id).all<{ persona_id: string; presence_mode: string }>();
    expect(personas.results).toHaveLength(3);
    expect(personas.results.map((row) => row.presence_mode)).toEqual(["exclusive", "exclusive", "parallel"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_snapshots WHERE travel_session_id = ?")
      .bind(raw.travel_session_id).first<{ count: number }>())?.count).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_routes WHERE travel_session_id = ?")
      .bind(raw.travel_session_id).first<{ count: number }>())?.count).toBe(3);
    expect(await getCurrentSession(env.DB)).toMatchObject({ travel_session_id: raw.travel_session_id });
    const current = await getCurrentSession(env.DB);
    expect((current?.personas as unknown[])).toHaveLength(3);
    expect((current?.personas as Array<Record<string, unknown>>)[0]).toMatchObject({
      inherited_recent_messages: [{ role: "user", content: "before departure" }],
      snapshot_created_at: raw.personas[0]!.home_anchor.created_at,
    });
    const summary = await getUsageSummary(env.DB, raw.travel_session_id, "2026-07-16T00:01:00Z", raw.personas[0]!.persona_id);
    expect(summary.persona_budget).toEqual({
      daily_limit_usd: 0.5, session_limit_usd: 0.5, max_output_tokens: 1024,
    });
  });

  it("persona別の日次利用額と保留額を他personaから分離する", async () => {
    const raw = snapshot(crypto.randomUUID());
    await registerSnapshot(env.DB, raw);
    const eventA = `event-a-${raw.travel_session_id}`;
    const eventB = `event-b-${raw.travel_session_id}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO travel_events
         (event_id, travel_session_id, persona_id, sequence_no, type, created_at, content, content_hash,
          provider, model_requested, model_resolved, status)
         VALUES (?, ?, ?, 1, 'assistant_message', ?, 'a', 'hash-a', 'gemini', 'model-a', 'model-a', 'committed')`,
      ).bind(eventA, raw.travel_session_id, raw.personas[0]!.persona_id, "2026-07-16T00:01:00Z"),
      env.DB.prepare(
        `INSERT INTO travel_events
         (event_id, travel_session_id, persona_id, sequence_no, type, created_at, content, content_hash,
          provider, model_requested, model_resolved, status)
         VALUES (?, ?, ?, 1, 'assistant_message', ?, 'b', 'hash-b', 'openai', 'model-b', 'model-b', 'committed')`,
      ).bind(eventB, raw.travel_session_id, raw.personas[1]!.persona_id, "2026-07-16T00:01:00Z"),
      env.DB.prepare(
        `INSERT INTO usage_receipts
         (receipt_id, event_id, travel_session_id, persona_id, occurred_at, provider, credential_profile_id,
          model_requested, model_resolved, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          provider_reported_cost_usd, usage_status, signature)
         VALUES (?, ?, ?, ?, ?, 'gemini', 'gemini-personal-1', 'model-a', 'model-a', 1, 1, 0, 0, 0.1, 'reported', 'sig-a')`,
      ).bind(`receipt-a-${raw.travel_session_id}`, eventA, raw.travel_session_id, raw.personas[0]!.persona_id, "2026-07-16T00:01:00Z"),
      env.DB.prepare(
        `INSERT INTO usage_receipts
         (receipt_id, event_id, travel_session_id, persona_id, occurred_at, provider, credential_profile_id,
          model_requested, model_resolved, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          provider_reported_cost_usd, usage_status, signature)
         VALUES (?, ?, ?, ?, ?, 'openai', 'openai-personal-1', 'model-b', 'model-b', 1, 1, 0, 0, 0.2, 'reported', 'sig-b')`,
      ).bind(`receipt-b-${raw.travel_session_id}`, eventB, raw.travel_session_id, raw.personas[1]!.persona_id, "2026-07-16T00:01:00Z"),
    ]);
    const first = await getUsageSummary(env.DB, raw.travel_session_id, "2026-07-16T00:02:00Z", raw.personas[0]!.persona_id);
    const second = await getUsageSummary(env.DB, raw.travel_session_id, "2026-07-16T00:02:00Z", raw.personas[1]!.persona_id);
    expect(first.known_cost_usd).toBeCloseTo(0.1);
    expect(first.daily_known_cost_usd).toBeCloseTo(0.1);
    expect(second.known_cost_usd).toBeCloseTo(0.2);
    expect(second.daily_known_cost_usd).toBeCloseTo(0.2);
  });

  it("3personaを異なるproviderへ送りeventとreceiptを混線させない", async () => {
    const suffix = crypto.randomUUID();
    await upsertProviderProfile(env.DB, `openai-p4-${suffix}`, {
      display_name: "OpenAI Phase 4", provider: "openai", secret_binding_id: "OPENAI_PERSONAL_1",
      allowed_base_url_id: "openai-official", enabled: true,
    }, "2026-07-16T00:00:00Z");
    await upsertProviderProfile(env.DB, `xai-p4-${suffix}`, {
      display_name: "xAI Phase 4", provider: "xai", secret_binding_id: "XAI_PERSONAL_1",
      allowed_base_url_id: "xai-official", enabled: true,
    }, "2026-07-16T00:00:00Z");
    const raw = snapshot(suffix);
    raw.session_budget.allow_unknown_price = true;
    raw.personas[0]!.initial_route = { credential_profile_id: "gemini-personal-1", model_id: "model-phase1" };
    raw.personas[1]!.initial_route = { credential_profile_id: `openai-p4-${suffix}`, model_id: "model-phase0" };
    raw.personas[2]!.initial_route = { credential_profile_id: `xai-p4-${suffix}`, model_id: "model-phase0" };
    await registerSnapshot(env.DB, raw);
    const fixtures = [geminiNormal, openaiNormal, xaiNormal];
    for (const [index, persona] of raw.personas.entries()) {
      const response = await streamTravelMessage(env.DB, env, raw.travel_session_id, {
        client_message_id: `phase4_${index}_${suffix}`, persona_id: persona.persona_id, message: `Question ${index}`,
      }, (async () => new Response(fixtures[index], {
        status: 200, headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(await response.text()).toContain("response.committed");
      const events = await getEventsAfterCursor(env.DB, raw.travel_session_id, persona.persona_id, 0);
      expect(events.events.map((event) => event.persona_id)).toEqual([persona.persona_id, persona.persona_id]);
    }
    const receipts = await env.DB.prepare(
      "SELECT persona_id, provider FROM usage_receipts WHERE travel_session_id = ? ORDER BY persona_id",
    ).bind(raw.travel_session_id).all<{ persona_id: string; provider: string }>();
    expect(receipts.results).toEqual([
      { persona_id: raw.personas[0]!.persona_id, provider: "gemini" },
      { persona_id: raw.personas[1]!.persona_id, provider: "openai" },
      { persona_id: raw.personas[2]!.persona_id, provider: "xai" },
    ]);

    const manifest = await startReturn(env.DB, raw.travel_session_id, "2026-07-16T01:00:00Z");
    expect(manifest.personas).toHaveLength(3);
    await expect(streamTravelMessage(env.DB, env, raw.travel_session_id, {
      client_message_id: `after_return_${suffix}`, persona_id: raw.personas[0]!.persona_id, message: "blocked",
    })).resolves.toMatchObject({ status: 409 });
    await expect(closeSession(env.DB, raw.travel_session_id, new Date("2026-07-16T01:01:00Z")))
      .rejects.toThrow("return_ack_incomplete");
    for (const persona of raw.personas) {
      const chunk = await buildSignedReturnChunk(
        env.DB, raw.travel_session_id, persona.persona_id, 0, "phase1-signing-test-key", "2026-07-16T01:02:00Z",
      );
      expect(chunk.payload.cursor).toEqual({ after_sequence: 0, through_sequence: 2 });
      expect(chunk.payload.events).toHaveLength(2);
      const ack = {
        ack_id: `ack_${persona.persona_id}`, persona_id: persona.persona_id,
        through_sequence: 2, payload_hash: chunk.payload_hash,
      };
      expect(await acknowledgeReturn(env.DB, raw.travel_session_id, ack, "2026-07-16T01:03:00Z"))
        .toMatchObject({ acknowledged: true, duplicate: false });
      expect(await acknowledgeReturn(env.DB, raw.travel_session_id, ack, "2026-07-16T01:03:01Z"))
        .toMatchObject({ acknowledged: true, duplicate: true });
    }
    await expect(closeSession(env.DB, raw.travel_session_id, new Date("2026-07-16T01:04:00Z"))).resolves.toBeUndefined();
  });

  it("1personaの緊急帰還だけを停止し他personaを継続する", async () => {
    const raw = snapshot(crypto.randomUUID());
    await registerSnapshot(env.DB, raw);
    const target = raw.personas[0]!.persona_id;
    expect(await emergencyReclaimPersona(
      env.DB, raw.travel_session_id, target, "Workerへ到達不能", "2026-07-16T02:00:00Z",
    )).toEqual({ reclaimed: true, duplicate: false });
    expect(await emergencyReclaimPersona(
      env.DB, raw.travel_session_id, target, "Workerへ到達不能", "2026-07-16T02:00:01Z",
    )).toEqual({ reclaimed: true, duplicate: true });
    const rows = await env.DB.prepare(
      "SELECT persona_id, status, branch_divergence_possible FROM travel_personas WHERE travel_session_id = ? ORDER BY persona_id",
    ).bind(raw.travel_session_id).all<{ persona_id: string; status: string; branch_divergence_possible: number }>();
    expect(rows.results.find((row) => row.persona_id === target)).toMatchObject({
      status: "emergency_reclaimed", branch_divergence_possible: 1,
    });
    expect(rows.results.filter((row) => row.persona_id !== target).every((row) => row.status === "active")).toBe(true);
  });

  it("provider応答中は複数端末の帰宅開始を止め、確定後は同じhigh-waterへ収束する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    raw.session_budget.allow_unknown_price = true;
    raw.personas[0]!.initial_route = { credential_profile_id: "gemini-personal-1", model_id: "model-phase1" };
    await registerSnapshot(env.DB, raw);

    let providerReached!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerReached = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const responsePromise = streamTravelMessage(env.DB, env, raw.travel_session_id, {
      client_message_id: `return_race_${suffix}`,
      persona_id: raw.personas[0]!.persona_id,
      message: "帰宅と競合する質問",
    }, (async () => {
      providerReached();
      await providerGate;
      return new Response(geminiNormal, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch);
    await providerStarted;

    const blocked = await Promise.allSettled([
      startReturn(env.DB, raw.travel_session_id, "2026-07-16T03:00:00Z"),
      startReturn(env.DB, raw.travel_session_id, "2026-07-16T03:00:01Z"),
    ]);
    expect(blocked.every((result) => result.status === "rejected" && result.reason.message === "session_message_in_progress"))
      .toBe(true);
    expect((await env.DB.prepare("SELECT status FROM travel_sessions WHERE travel_session_id = ?")
      .bind(raw.travel_session_id).first<{ status: string }>())?.status).toBe("active");

    releaseProvider();
    const response = await responsePromise;
    expect(await response.text()).toContain("response.committed");
    expect((await getMessageRequest(env.DB, `return_race_${suffix}`))?.status).toBe("completed");

    const manifests = await Promise.all([
      startReturn(env.DB, raw.travel_session_id, "2026-07-16T03:01:00Z"),
      startReturn(env.DB, raw.travel_session_id, "2026-07-16T03:01:01Z"),
    ]);
    for (const manifest of manifests) {
      expect(manifest.personas.map((persona) => persona.high_water_sequence)).toEqual([2, 0, 0]);
    }
    await expect(streamTravelMessage(env.DB, env, raw.travel_session_id, {
      client_message_id: `after_frozen_${suffix}`,
      persona_id: raw.personas[0]!.persona_id,
      message: "帰宅開始後の送信",
    })).resolves.toMatchObject({ status: 409 });
    const chunk = await buildSignedReturnChunk(
      env.DB, raw.travel_session_id, raw.personas[0]!.persona_id, 0,
      "phase1-signing-test-key", "2026-07-16T03:02:00Z",
    );
    expect(chunk.payload.cursor).toEqual({ after_sequence: 0, through_sequence: 2 });
  });

  it("retention 0の緊急帰還後に遅着したprovider応答をcommitしない", async () => {
    const suffix = crypto.randomUUID();
    const raw = { ...snapshot(suffix), retention_days: 0 as const };
    raw.session_budget.allow_unknown_price = true;
    raw.personas[0]!.initial_route = { credential_profile_id: "gemini-personal-1", model_id: "model-phase1" };
    await registerSnapshot(env.DB, raw);
    const personaId = raw.personas[0]!.persona_id;

    let providerReached!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerReached = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const responsePromise = streamTravelMessage(env.DB, env, raw.travel_session_id, {
      client_message_id: `reclaim_race_${suffix}`,
      persona_id: personaId,
      message: "緊急帰還と競合する質問",
    }, (async () => {
      providerReached();
      await providerGate;
      return new Response(geminiNormal, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch);
    await providerStarted;
    await emergencyReclaimPersona(
      env.DB, raw.travel_session_id, personaId, "PCを復旧したため緊急帰還", "2026-07-16T04:00:00Z",
    );

    releaseProvider();
    const response = await responsePromise;
    expect(await response.text()).toContain("persistence_failed");
    expect((await getMessageRequest(env.DB, `reclaim_race_${suffix}`))?.status).toBe("outcome_unknown");
    expect((await getEventsAfterCursor(env.DB, raw.travel_session_id, personaId, 0)).events).toHaveLength(0);
    const chunk = await buildSignedReturnChunk(
      env.DB, raw.travel_session_id, personaId, 0,
      "phase1-signing-test-key", "2026-07-16T04:01:00Z",
    );
    expect(chunk.payload.cursor).toEqual({ after_sequence: 0, through_sequence: 0 });
  });
});
