import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getUsageSummary, reserveBudget } from "../src/budget";
import { registerSnapshot } from "../src/phase1";
import { getPersonaRoute } from "../src/phase2-routing";
import { deleteProviderCaches, ensureProviderCache } from "../src/provider-cache";
import { createTravelSession, getMessageRequest, reserveMessage } from "../src/storage";

describe("Phase 3 budget and provider cache", () => {
  it("既知価格は上限を守り、価格不明でも送信を妨げない", async () => {
    const sessionId = `phase3-budget-${crypto.randomUUID()}`;
    await createTravelSession(env.DB, { travelSessionId: sessionId, retentionDays: 7, createdAt: "2026-07-16T00:00:00Z" });
    await env.DB.prepare(
      `UPDATE travel_sessions SET budget_daily_limit_usd = ?, budget_session_limit_usd = ?,
       budget_allow_unknown_price = 0, budget_max_output_tokens = 2048, budget_timezone = 'Asia/Tokyo'
       WHERE travel_session_id = ?`,
    ).bind(1, 0.01, sessionId).run();
    await reserveMessage(env.DB, {
      clientMessageId: `${sessionId}-known`, travelSessionId: sessionId, personaId: "persona-phase3",
      provider: "openai", modelRequested: "gpt-5.4-nano", reservedAt: "2026-07-16T01:00:00Z",
    });
    const reserved = await reserveBudget(env.DB, {
      clientMessageId: `${sessionId}-known`, travelSessionId: sessionId, provider: "openai",
      model: "gpt-5.4-nano", inputTokenUpperBound: 1000, nowIso: "2026-07-16T01:00:00Z",
    });
    expect(reserved).toBeGreaterThan(0);
    expect((await getMessageRequest(env.DB, `${sessionId}-known`))?.budget_state).toBe("reserved");
    expect((await getUsageSummary(env.DB, sessionId, "2026-07-16T01:00:00Z")).pending_reserved_usd).toBe(reserved);
    await env.DB.prepare(
      "UPDATE message_requests SET status = 'completed', budget_state = 'settled', budget_settled_usd = ? WHERE client_message_id = ?",
    ).bind(reserved, `${sessionId}-known`).run();

    await reserveMessage(env.DB, {
      clientMessageId: `${sessionId}-large`, travelSessionId: sessionId, personaId: "persona-phase3",
      provider: "openai", modelRequested: "gpt-5.4-nano", reservedAt: "2026-07-16T01:00:01Z",
    });
    await expect(reserveBudget(env.DB, {
      clientMessageId: `${sessionId}-large`, travelSessionId: sessionId, provider: "openai",
      model: "gpt-5.4-nano", inputTokenUpperBound: 1_000_000, nowIso: "2026-07-16T01:00:01Z",
    })).rejects.toThrow("budget_limit_exceeded");
    await env.DB.prepare("UPDATE message_requests SET status = 'failed_known' WHERE client_message_id = ?")
      .bind(`${sessionId}-large`).run();

    await reserveMessage(env.DB, {
      clientMessageId: `${sessionId}-unknown`, travelSessionId: sessionId, personaId: "persona-phase3",
      provider: "openai", modelRequested: "future-model", reservedAt: "2026-07-16T01:00:02Z",
    });
    const unknownReserved = await reserveBudget(env.DB, {
      clientMessageId: `${sessionId}-unknown`, travelSessionId: sessionId, provider: "openai",
      model: "future-model", inputTokenUpperBound: 100, nowIso: "2026-07-16T01:00:02Z",
    });
    expect((await getUsageSummary(env.DB, sessionId, "2026-07-16T01:00:03Z")).pending_reserved_usd).toBe(0);
    expect(unknownReserved).toBeNull();
    expect((await getMessageRequest(env.DB, `${sessionId}-unknown`))?.budget_state).toBe("unknown_allowed");
  });

  it("Gemini明示cacheは1時間保管料を含む上限をprovider前に判定する", async () => {
    const sessionId = `phase3-cache-budget-${crypto.randomUUID()}`;
    await createTravelSession(env.DB, { travelSessionId: sessionId, retentionDays: 7, createdAt: "2026-07-16T00:00:00Z" });
    await env.DB.prepare(
      `UPDATE travel_sessions SET budget_daily_limit_usd = 1, budget_session_limit_usd = 0.01,
       budget_allow_unknown_price = 0, budget_max_output_tokens = 128, budget_timezone = 'Asia/Tokyo',
       cache_policy = 'gemini_explicit' WHERE travel_session_id = ?`,
    ).bind(sessionId).run();
    await reserveMessage(env.DB, {
      clientMessageId: `${sessionId}-blocked`, travelSessionId: sessionId, personaId: "persona-phase3",
      provider: "gemini", modelRequested: "gemini-2.5-flash-lite", reservedAt: "2026-07-16T01:00:00Z",
    });
    await expect(reserveBudget(env.DB, {
      clientMessageId: `${sessionId}-blocked`, travelSessionId: sessionId, provider: "gemini",
      model: "gemini-2.5-flash-lite", inputTokenUpperBound: 65_000, nowIso: "2026-07-16T01:00:00Z",
    })).rejects.toThrow("budget_limit_exceeded");
    expect((await getMessageRequest(env.DB, `${sessionId}-blocked`))?.budget_state).toBeNull();
  });

  it("過去日のheld予約を今日の日次上限へ持ち越さない", async () => {
    const oldSessionId = `phase3-old-held-${crypto.randomUUID()}`;
    await createTravelSession(env.DB, {
      travelSessionId: oldSessionId,
      retentionDays: 0,
      createdAt: "2026-07-15T00:00:00Z",
    });
    await reserveMessage(env.DB, {
      clientMessageId: `${oldSessionId}-held`,
      travelSessionId: oldSessionId,
      personaId: "persona-phase3",
      provider: "gemini",
      modelRequested: "gemini-2.5-flash-lite",
      reservedAt: "2026-07-15T01:00:00Z",
    });
    await env.DB.prepare(
      `UPDATE message_requests
       SET status = 'partial', budget_state = 'held', budget_reserved_usd = 0.009
       WHERE client_message_id = ?`,
    ).bind(`${oldSessionId}-held`).run();

    const sessionId = `phase3-new-day-${crypto.randomUUID()}`;
    await createTravelSession(env.DB, {
      travelSessionId: sessionId,
      retentionDays: 0,
      createdAt: "2026-07-16T00:00:00Z",
    });
    await env.DB.prepare(
      `UPDATE travel_sessions SET budget_daily_limit_usd = 0.01, budget_session_limit_usd = 0.01,
       budget_allow_unknown_price = 0, budget_max_output_tokens = 256, budget_timezone = 'Asia/Tokyo'
       WHERE travel_session_id = ?`,
    ).bind(sessionId).run();
    await reserveMessage(env.DB, {
      clientMessageId: `${sessionId}-known`,
      travelSessionId: sessionId,
      personaId: "persona-phase3",
      provider: "gemini",
      modelRequested: "gemini-2.5-flash-lite",
      reservedAt: "2026-07-16T01:00:00Z",
    });

    const summary = await getUsageSummary(env.DB, sessionId, "2026-07-16T01:00:00Z");
    expect(summary.daily_pending_reserved_usd).toBe(0);
    await expect(reserveBudget(env.DB, {
      clientMessageId: `${sessionId}-known`,
      travelSessionId: sessionId,
      provider: "gemini",
      model: "gemini-2.5-flash-lite",
      inputTokenUpperBound: 80_000,
      nowIso: "2026-07-16T01:00:00Z",
    })).resolves.toBeGreaterThan(0);
  });

  it("Gemini明示cacheをsnapshot hash単位で再利用しclose時に削除する", async () => {
    const suffix = crypto.randomUUID();
    const profileId = "gemini-personal-1";
    const snapshot = {
      schema_version: 3 as const, travel_session_id: `phase3-cache-${suffix}`, persona_id: `persona-${suffix}`,
      persona_display_name: "Phase 3 Persona", system_prompt: "Stable system prompt", core_memory: "core",
      episodic_summary: "", recent_messages: [{ role: "user", content: "Synthetic stable cache content." }],
      initial_route: { credential_profile_id: profileId, model_id: "gemini-2.5-flash-lite" },
      budget: { daily_limit_usd: 1, session_limit_usd: 0.5, warning_ratio: 0.8, allow_unknown_price: false,
        max_output_tokens: 2048, timezone: "Asia/Tokyo" },
      cache_policy: "gemini_explicit" as const, retention_days: 7 as const, created_at: "2026-07-16T02:00:00Z",
    };
    await registerSnapshot(env.DB, snapshot);
    const route = await getPersonaRoute(env.DB, snapshot.travel_session_id, snapshot.persona_id);
    expect(route).not.toBeNull();
    const profile = await env.DB.prepare("SELECT * FROM provider_profiles WHERE credential_profile_id = ?")
      .bind(profileId).first<any>();
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(`${init?.method || "GET"} ${String(input)}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(input).endsWith(":countTokens")) return Response.json({ totalTokens: 4096 });
      return Response.json({ name: "cachedContents/synthetic", expireTime: "2026-07-16T04:00:00Z", usageMetadata: { totalTokenCount: 42 } });
    };
    const now = new Date("2026-07-16T02:00:00Z");
    const first = await ensureProviderCache(env.DB, env, profile!, route!, snapshot, "snapshot-hash", fetcher, now);
    const second = await ensureProviderCache(env.DB, env, profile!, route!, snapshot, "snapshot-hash", fetcher, now);
    expect(first).toMatchObject({ remoteCacheName: "cachedContents/synthetic", justCreated: true, cacheCreationTokens: 42 });
    expect(second).toMatchObject({ remoteCacheName: "cachedContents/synthetic", justCreated: false });
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
    expect(calls.filter((call) => call.includes(":countTokens"))).toHaveLength(1);
    expect(await deleteProviderCaches(env.DB, env, snapshot.travel_session_id, fetcher, now)).toBe(1);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
  });

  it("安定contentsが空ならGemini cache APIを呼ばず通常入力へfallbackする", async () => {
    const suffix = crypto.randomUUID();
    const snapshot = {
      schema_version: 3 as const, travel_session_id: `phase3-cache-empty-${suffix}`, persona_id: `persona-${suffix}`,
      persona_display_name: "Phase 3 Empty Cache", system_prompt: "System only", core_memory: "", episodic_summary: "",
      recent_messages: [], initial_route: { credential_profile_id: "gemini-personal-1", model_id: "gemini-2.5-flash-lite" },
      budget: { daily_limit_usd: 1, session_limit_usd: 0.5, warning_ratio: 0.8, allow_unknown_price: false,
        max_output_tokens: 2048, timezone: "Asia/Tokyo" },
      cache_policy: "gemini_explicit" as const, retention_days: 7 as const, created_at: "2026-07-16T02:00:00Z",
    };
    await registerSnapshot(env.DB, snapshot);
    const route = await getPersonaRoute(env.DB, snapshot.travel_session_id, snapshot.persona_id);
    const profile = await env.DB.prepare("SELECT * FROM provider_profiles WHERE credential_profile_id = 'gemini-personal-1'")
      .first<any>();
    let calls = 0;
    const result = await ensureProviderCache(
      env.DB, env, profile!, route!, snapshot, "empty-hash",
      (async () => { calls += 1; return new Response(null, { status: 500 }); }) as typeof fetch,
      new Date("2026-07-16T02:00:00Z"),
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
    const row = await env.DB.prepare("SELECT status, failure_code FROM provider_cache_entries WHERE travel_session_id = ?")
      .bind(snapshot.travel_session_id).first<{ status: string; failure_code: string }>();
    expect(row).toEqual({ status: "unavailable", failure_code: "cache_requires_stable_contents" });
  });
});
