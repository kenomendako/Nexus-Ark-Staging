import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { canonicalJson, hmacSha256, sha256 } from "../src/auth";
import worker from "../src/index";
import { closeSession, deleteExpiredContent, registerSnapshot, validateSnapshot } from "../src/phase1";

const OWNER_HEADERS = {
  Authorization: "Bearer phase1-owner-test-token",
  "Content-Type": "application/json",
};

function snapshot(suffix: string, retentionDays: 0 | 7 | 30 = 7) {
  return {
    schema_version: 1,
    travel_session_id: `phase1-session-${suffix}`,
    persona_id: `phase1-persona-${suffix}`,
    persona_display_name: "Phase 1 Persona",
    system_prompt: "You are the synthetic Phase 1 persona.",
    core_memory: "Synthetic core memory only.",
    episodic_summary: "Synthetic episode only.",
    recent_messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello" },
    ],
    model_id: "model-phase1",
    retention_days: retentionDays,
    created_at: "2026-07-15T08:00:00.000Z",
  };
}

async function pairDevice(suffix: string) {
  const codeResponse = await worker.fetch(
    new Request("https://worker.test/v1/pairing-codes", { method: "POST", headers: OWNER_HEADERS }),
    env,
  );
  expect(codeResponse.status).toBe(201);
  const codeBody = await codeResponse.json<{ code: string }>();
  const pairResponse = await worker.fetch(
    new Request("https://worker.test/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeBody.code, display_name: `device-${suffix}` }),
    }),
    env,
  );
  expect(pairResponse.status).toBe(201);
  return { code: codeBody.code, tokens: await pairResponse.json<Record<string, string>>() };
}

describe("Phase 1 auth, snapshot, bundle and retention", () => {
  it("snapshotをallowlistで検証し秘密情報とローカル絶対パスを拒否する", () => {
    expect(validateSnapshot(snapshot("valid")).schema_version).toBe(1);
    expect(() => validateSnapshot({ ...snapshot("secret"), api_key: "not-a-real-key" })).toThrow(
      "snapshot_field_not_allowed",
    );
    expect(() => validateSnapshot({ ...snapshot("path"), core_memory: "/home/example/private.txt" })).toThrow(
      "snapshot_contains_local_path",
    );
    expect(() => validateSnapshot({ ...snapshot("secret-value"), core_memory: "sk-abcdefghijklmnopqrstuvwxyz" })).toThrow(
      "snapshot_contains_secret",
    );
    expect(() =>
      validateSnapshot({ ...snapshot("role"), recent_messages: [{ role: "system", content: "no" }] }),
    ).toThrow("invalid_snapshot");
  });

  it("pairing codeを単回消費しD1へ生tokenを保存しない", async () => {
    const { code, tokens } = await pairDevice(crypto.randomUUID());
    const reuse = await worker.fetch(
      new Request("https://worker.test/v1/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, display_name: "reused" }),
      }),
      env,
    );
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toEqual({ error: "pairing_code_invalid" });

    const row = await env.DB
      .prepare("SELECT access_token_hash, refresh_token_hash FROM travel_devices WHERE device_id = ?")
      .bind(tokens.device_id)
      .first<{ access_token_hash: string; refresh_token_hash: string }>();
    expect(row?.access_token_hash).toBe(await sha256(String(tokens.access_token)));
    expect(row?.refresh_token_hash).toBe(await sha256(String(tokens.refresh_token)));
    expect(JSON.stringify(row)).not.toContain(tokens.access_token);
    expect(JSON.stringify(row)).not.toContain(tokens.refresh_token);
  });

  it("有効な登録済み端末の再ペアリングは台数を増やさずtokenをローテーションする", async () => {
    const countBefore = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM travel_devices")
      .first<{ count: number }>();
    const first = await pairDevice(crypto.randomUUID());
    const codeResponse = await worker.fetch(
      new Request("https://worker.test/v1/pairing-codes", { method: "POST", headers: OWNER_HEADERS }),
      env,
    );
    const codeBody = await codeResponse.json<{ code: string }>();
    const repairedResponse = await worker.fetch(
      new Request("https://worker.test/v1/devices/pair", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${first.tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: codeBody.code, display_name: "same-device" }),
      }),
      env,
    );
    expect(repairedResponse.status).toBe(201);
    const repaired = await repairedResponse.json<Record<string, string>>();
    expect(repaired.device_id).toBe(first.tokens.device_id);
    expect(repaired.access_token).not.toBe(first.tokens.access_token);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM travel_devices").first<{ count: number }>();
    expect(Number(count?.count ?? 0)).toBe(Number(countBefore?.count ?? 0) + 1);

    const oldAccess = await worker.fetch(new Request("https://worker.test/v1/travel-sessions/current", {
      headers: { Authorization: `Bearer ${first.tokens.access_token}` },
    }), env);
    expect(oldAccess.status).toBe(401);
    const newAccess = await worker.fetch(new Request("https://worker.test/v1/travel-sessions/current", {
      headers: { Authorization: `Bearer ${repaired.access_token}` },
    }), env);
    expect(newAccess.status).toBe(200);
  });

  it("refresh tokenをローテーションし旧access／refreshを無効化できる", async () => {
    const { tokens } = await pairDevice(crypto.randomUUID());
    const refreshedResponse = await worker.fetch(
      new Request("https://worker.test/v1/devices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      }),
      env,
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json<Record<string, string>>();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const oldAccess = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions/current", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
      env,
    );
    expect(oldAccess.status).toBe(401);
    const oldRefresh = await worker.fetch(
      new Request("https://worker.test/v1/devices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      }),
      env,
    );
    expect(oldRefresh.status).toBe(401);

    const selfRevoke = await worker.fetch(
      new Request("https://worker.test/v1/devices/self/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${refreshed.access_token}` },
      }),
      env,
    );
    expect(selfRevoke.status).toBe(200);
    expect(await selfRevoke.json()).toEqual({ revoked: true });
    const revokedAccess = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions/current", {
        headers: { Authorization: `Bearer ${refreshed.access_token}` },
      }),
      env,
    );
    expect(revokedAccess.status).toBe(401);
  });

  it("ownerだけがsnapshotを登録し端末は最小情報だけ取得する", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    const denied = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(raw),
      }),
      env,
    );
    expect(denied.status).toBe(401);
    const created = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions", {
        method: "POST",
        headers: OWNER_HEADERS,
        body: JSON.stringify(raw),
      }),
      env,
    );
    expect(created.status).toBe(201);

    const { tokens } = await pairDevice(suffix);
    const current = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions/current", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
      env,
    );
    const body = await current.json<{ session: Record<string, unknown> }>();
    expect(current.status).toBe(200);
    expect(body.session.travel_session_id).toBe(raw.travel_session_id);
    expect(body.session.persona_display_name).toBe(raw.persona_display_name);
    expect(body.session.inherited_recent_messages).toEqual(raw.recent_messages);
    expect(body.session.snapshot_created_at).toBe(raw.created_at);
    expect(JSON.stringify(body)).not.toContain(raw.system_prompt);
    expect(JSON.stringify(body)).not.toContain(raw.core_memory);
  });

  it("canonical payloadへ署名した帰宅bundleを返す", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix);
    await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions", {
        method: "POST",
        headers: OWNER_HEADERS,
        body: JSON.stringify(raw),
      }),
      env,
    );
    const response = await worker.fetch(
      new Request(`https://worker.test/v1/travel-sessions/${raw.travel_session_id}/export`, {
        method: "POST",
        headers: OWNER_HEADERS,
      }),
      env,
    );
    const bundle = await response.json<{
      payload: {
        schema_version: number;
        session: { initial_route: Record<string, unknown>; final_route: Record<string, unknown> };
      };
      payload_canonical: string;
      payload_hash: string;
      signature: string;
    }>();
    expect(response.status).toBe(200);
    expect(bundle.payload.schema_version).toBe(2);
    expect(bundle.payload.session.initial_route).toEqual({
      credential_profile_id: "gemini-personal-1",
      provider: "gemini",
      model_id: "model-phase1",
      route_epoch: 0,
    });
    expect(bundle.payload.session.final_route).toEqual(bundle.payload.session.initial_route);
    expect(bundle.payload_canonical).toBe(canonicalJson(bundle.payload));
    expect(bundle.payload_hash).toBe(await sha256(bundle.payload_canonical));
    expect(bundle.signature).toBe(await hmacSha256(bundle.payload_canonical, "phase1-signing-test-key"));
  });

  it("保持0日のcloseでsnapshot本文を削除し監査用sessionを残す", async () => {
    const suffix = crypto.randomUUID();
    const raw = snapshot(suffix, 0);
    await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions", {
        method: "POST",
        headers: OWNER_HEADERS,
        body: JSON.stringify(raw),
      }),
      env,
    );
    const close = await worker.fetch(
      new Request(`https://worker.test/v1/travel-sessions/${raw.travel_session_id}/close`, {
        method: "POST",
        headers: OWNER_HEADERS,
      }),
      env,
    );
    expect(close.status).toBe(200);
    expect(
      await env.DB
        .prepare("SELECT travel_session_id FROM persona_snapshots WHERE travel_session_id = ?")
        .bind(raw.travel_session_id)
        .first(),
    ).toBeNull();
    const session = await env.DB
      .prepare("SELECT status, content_deleted_at FROM travel_sessions WHERE travel_session_id = ?")
      .bind(raw.travel_session_id)
      .first<{ status: string; content_deleted_at: string | null }>();
    expect(session?.status).toBe("closed");
    expect(session?.content_deleted_at).not.toBeNull();
  });

  it("保持7日／30日は期限前に消さず期限到来後に自動削除する", async () => {
    for (const days of [7, 30] as const) {
      const suffix = crypto.randomUUID();
      const raw = snapshot(suffix, days);
      await registerSnapshot(env.DB, raw);
      const closedAt = new Date("2026-07-15T10:00:00.000Z");
      await closeSession(env.DB, raw.travel_session_id, closedAt);
      expect(await deleteExpiredContent(env.DB, new Date(closedAt.getTime() + (days * 24 * 60 * 60_000) - 1).toISOString())).toBe(0);
      expect(
        await env.DB.prepare("SELECT travel_session_id FROM persona_snapshots WHERE travel_session_id = ?")
          .bind(raw.travel_session_id).first(),
      ).not.toBeNull();
      expect(await deleteExpiredContent(env.DB, new Date(closedAt.getTime() + days * 24 * 60 * 60_000).toISOString())).toBe(1);
      expect(
        await env.DB.prepare("SELECT travel_session_id FROM persona_snapshots WHERE travel_session_id = ?")
          .bind(raw.travel_session_id).first(),
      ).toBeNull();
    }
  });
});
