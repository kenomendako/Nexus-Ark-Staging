import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { registerSnapshot, validateSnapshot } from "../src/phase1";
import {
  changePersonaRoute,
  getPersonaRoute,
  upsertProviderProfile,
} from "../src/phase2-routing";
import { getEventsAfterCursor, markProviderStarted, reserveMessage } from "../src/storage";

const OWNER_HEADERS = {
  Authorization: "Bearer phase1-owner-test-token",
  "Content-Type": "application/json",
};
const OPENAI_PROFILE_ID = "openai-phase2-test";

function snapshotV1(suffix: string) {
  return {
    schema_version: 1,
    travel_session_id: `phase2-v1-${suffix}`,
    persona_id: `phase2-persona-${suffix}`,
    persona_display_name: "Phase 1 Compatible Persona",
    system_prompt: "Synthetic prompt.",
    core_memory: "",
    episodic_summary: "",
    recent_messages: [],
    model_id: "model-phase1",
    retention_days: 7,
    created_at: "2026-07-16T01:00:00.000Z",
  };
}

function snapshotV2(suffix: string, profileId = "gemini-personal-1", modelId = "model-phase1") {
  return {
    schema_version: 2,
    travel_session_id: `phase2-v2-${suffix}`,
    persona_id: `phase2-persona-${suffix}`,
    persona_display_name: "Phase 2 Persona",
    system_prompt: "Synthetic prompt.",
    core_memory: "Synthetic memory.",
    episodic_summary: "",
    recent_messages: [],
    initial_route: { credential_profile_id: profileId, model_id: modelId },
    retention_days: 7,
    created_at: "2026-07-16T01:00:00.000Z",
  };
}

async function pairDevice(suffix: string): Promise<Record<string, string>> {
  const codeResponse = await worker.fetch(
    new Request("https://worker.test/v1/pairing-codes", { method: "POST", headers: OWNER_HEADERS }),
    env,
  );
  const code = await codeResponse.json<{ code: string }>();
  const response = await worker.fetch(
    new Request("https://worker.test/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.code, display_name: `phase2-device-${suffix}` }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  return response.json<Record<string, string>>();
}

describe("Phase 2 profile, snapshot and route contract", () => {
  it("snapshot v1をGemini epoch 0 routeへ移行しv2もallowlist検証する", async () => {
    const suffix = crypto.randomUUID();
    const legacy = snapshotV1(suffix);
    expect(validateSnapshot(legacy).schema_version).toBe(1);
    await registerSnapshot(env.DB, legacy);
    expect(await getPersonaRoute(env.DB, legacy.travel_session_id, legacy.persona_id)).toMatchObject({
      credential_profile_id: "gemini-personal-1",
      provider: "gemini",
      model_id: "model-phase1",
      route_epoch: 0,
    });

    const next = snapshotV2(`${suffix}-v2`);
    expect(validateSnapshot(next)).toMatchObject({ schema_version: 2, initial_route: next.initial_route });
    expect(() => validateSnapshot({ ...next, provider: "gemini" })).toThrow("snapshot_field_not_allowed");
    expect(() => validateSnapshot({ ...next, initial_route: { ...next.initial_route, provider: "gemini" } })).toThrow(
      "invalid_snapshot",
    );
  });

  it("profileのprovider・binding・host対応を固定し端末へbinding IDを返さない", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const profileId = OPENAI_PROFILE_ID;
    const created = await worker.fetch(
      new Request(`https://worker.test/v1/provider-profiles/${profileId}`, {
        method: "PUT",
        headers: OWNER_HEADERS,
        body: JSON.stringify({
          display_name: "OpenAI synthetic",
          provider: "openai",
          secret_binding_id: "OPENAI_PERSONAL_1",
          allowed_base_url_id: "openai-official",
          enabled: true,
        }),
      }),
      env,
    );
    expect(created.status).toBe(200);
    expect(JSON.stringify(await created.json())).not.toContain("OPENAI_PERSONAL_1");

    const mismatch = await worker.fetch(
      new Request(`https://worker.test/v1/provider-profiles/anthropic-${suffix}`, {
        method: "PUT",
        headers: OWNER_HEADERS,
        body: JSON.stringify({
          display_name: "Mismatch",
          provider: "anthropic",
          secret_binding_id: "OPENAI_PERSONAL_1",
          allowed_base_url_id: "anthropic-official",
        }),
      }),
      env,
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "provider_profile_binding_mismatch" });

    const identityChange = await worker.fetch(
      new Request(`https://worker.test/v1/provider-profiles/${profileId}`, {
        method: "PUT",
        headers: OWNER_HEADERS,
        body: JSON.stringify({
          display_name: "Identity change",
          provider: "openrouter",
          secret_binding_id: "OPENROUTER_PERSONAL_1",
          allowed_base_url_id: "openrouter-official",
        }),
      }),
      env,
    );
    expect(identityChange.status).toBe(400);
    expect(await identityChange.json()).toEqual({ error: "provider_profile_identity_immutable" });

    const tokens = await pairDevice(suffix);
    const list = await worker.fetch(
      new Request("https://worker.test/v1/provider-profiles", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
      env,
    );
    const body = await list.json<{ profiles: Array<Record<string, unknown>> }>();
    expect(list.status).toBe(200);
    expect(body.profiles.some((profile) => profile.credential_profile_id === profileId)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret_binding");
    expect(JSON.stringify(body)).not.toContain("OPENAI_PERSONAL_1");
  });

  it("snapshot v2の初期profileをD1 route正本へ保存する", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const profileId = OPENAI_PROFILE_ID;
    await upsertProviderProfile(
      env.DB,
      profileId,
      {
        display_name: "OpenAI v2",
        provider: "openai",
        secret_binding_id: "OPENAI_PERSONAL_1",
        allowed_base_url_id: "openai-official",
      },
      "2026-07-16T01:00:00.000Z",
    );
    const raw = snapshotV2(suffix, profileId, "gpt-synthetic");
    await registerSnapshot(env.DB, raw);
    expect(await getPersonaRoute(env.DB, raw.travel_session_id, raw.persona_id)).toMatchObject({
      credential_profile_id: profileId,
      provider: "openai",
      model_id: "gpt-synthetic",
      route_epoch: 0,
    });
    const stored = await env.DB
      .prepare("SELECT schema_version FROM persona_snapshots WHERE travel_session_id = ?")
      .bind(raw.travel_session_id)
      .first<{ schema_version: number }>();
    expect(stored?.schema_version).toBe(2);
  });

  it("同じroute_change_idを再送してもepochとeventを1回だけ増やす", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const profileId = OPENAI_PROFILE_ID;
    await upsertProviderProfile(
      env.DB,
      profileId,
      {
        display_name: "OpenAI route",
        provider: "openai",
        secret_binding_id: "OPENAI_PERSONAL_1",
        allowed_base_url_id: "openai-official",
      },
      "2026-07-16T01:00:00.000Z",
    );
    const raw = snapshotV2(suffix);
    await registerSnapshot(env.DB, raw);
    const input = {
      route_change_id: `route_${suffix}`,
      credential_profile_id: profileId,
      model_id: "gpt-route-synthetic",
    };
    const tokens = await pairDevice(suffix);
    const request = () =>
      worker.fetch(
        new Request(`https://worker.test/v1/travel-sessions/${raw.travel_session_id}/route`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
        env,
      );
    const firstResponse = await request();
    const secondResponse = await request();
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = await firstResponse.json<Record<string, unknown>>();
    const second = await secondResponse.json<Record<string, unknown>>();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ changed: true, route: { provider: "openai", route_epoch: 1 } });
    const events = await getEventsAfterCursor(env.DB, raw.travel_session_id, raw.persona_id, 0);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ type: "route_changed", route_epoch: 1, provider: "openai" });
  });

  it("送信予約中のroute変更をprovider開始前に拒否する", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const raw = snapshotV2(suffix);
    await registerSnapshot(env.DB, raw);
    await reserveMessage(env.DB, {
      clientMessageId: `active_${suffix}`,
      travelSessionId: raw.travel_session_id,
      personaId: raw.persona_id,
      provider: "gemini",
      modelRequested: "model-phase1",
      reservedAt: "2026-07-16T02:00:00.000Z",
    });
    await markProviderStarted(env.DB, `active_${suffix}`, "2026-07-16T02:00:01.000Z");
    await expect(
      changePersonaRoute(
        env.DB,
        raw.travel_session_id,
        {
          route_change_id: `blocked_${suffix}`,
          credential_profile_id: "gemini-personal-1",
          model_id: "other-model",
        },
        "2026-07-16T02:00:02.000Z",
      ),
    ).rejects.toThrow("session_message_in_progress");
    expect((await getPersonaRoute(env.DB, raw.travel_session_id, raw.persona_id))?.route_epoch).toBe(0);
  });
});
