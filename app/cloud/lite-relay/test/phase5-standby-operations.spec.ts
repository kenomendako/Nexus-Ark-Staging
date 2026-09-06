import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { ownerDiagnostics, retentionPreview, runRetention } from "../src/admin";
import {
  activateStandbySnapshot,
  buildStandbyExternalAiExport,
  listStandbySnapshots,
  registerStandbySnapshot,
} from "../src/standby";
import { buildActiveSessionExternalAiExport } from "../src/external-ai-export";

const KEY = "phase5-standby-encryption-test-key-0001";
const OWNER_HEADERS = {
  Authorization: "Bearer phase1-owner-test-token",
  "Content-Type": "application/json",
};

async function pairDevice(suffix: string): Promise<Record<string, string>> {
  const codeResponse = await worker.fetch(
    new Request("https://worker.test/v1/pairing-codes", { method: "POST", headers: OWNER_HEADERS }), env,
  );
  const code = await codeResponse.json<{ code: string }>();
  const response = await worker.fetch(new Request("https://worker.test/v1/devices/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.code, display_name: `external-export-device-${suffix}` }),
  }), env);
  expect(response.status).toBe(201);
  return response.json<Record<string, string>>();
}

function snapshot(suffix: string) {
  return {
    schema_version: 4 as const,
    travel_session_id: `standby-source-${suffix}`,
    retention_days: 7 as const,
    session_budget: {
      daily_limit_usd: 1,
      session_limit_usd: 1,
      warning_ratio: 0.8,
      allow_unknown_price: false,
      max_output_tokens: 1024,
      timezone: "Asia/Tokyo",
    },
    personas: [{
      persona_id: `standby-persona-${suffix}`,
      persona_display_name: "Standby Persona",
      presence_mode: "exclusive" as const,
      system_prompt: "安全な待機用プロンプト",
      core_memory: "core",
      episodic_summary: "summary",
      recent_messages: [],
      home_anchor: { created_at: "2026-07-17T00:00:00Z", log_tail_hash: `anchor-${suffix}` },
      initial_route: { credential_profile_id: "gemini-personal-1", model_id: "model-phase1" },
      budget: { daily_limit_usd: 1, session_limit_usd: 1, max_output_tokens: 1024 },
      cache_policy: "auto" as const,
    }],
    created_at: "2026-07-17T00:00:00Z",
  };
}

describe("Phase 5 standby snapshot", () => {
  it("明示同意時だけ選択personaを外部AI文面化し待機状態を変更しない", async () => {
    const suffix = crypto.randomUUID();
    const standby = await registerStandbySnapshot(
      env.DB,
      { home_instance_id: `home-${suffix}`, retention_days: 7, snapshot: snapshot(suffix) },
      KEY,
      "key-1",
      new Date("2026-07-17T00:00:00Z"),
    );
    const standbyId = String(standby.standby_snapshot_id);
    await expect(buildStandbyExternalAiExport(
      env.DB, standbyId, `standby-persona-${suffix}`, {}, KEY, new Date("2026-07-17T01:00:00Z"),
    )).rejects.toThrow("external_ai_disclosure_not_confirmed");
    const exported = await buildStandbyExternalAiExport(
      env.DB,
      standbyId,
      `standby-persona-${suffix}`,
      { disclosure_confirmed: true, recent_message_limit: 40 },
      KEY,
      new Date("2026-07-17T01:00:00Z"),
    );
    expect(exported).toMatchObject({ persona_display_name: "Standby Persona", source_label: "待機中のお出かけ前データ" });
    expect(String(exported.text)).toContain("安全な待機用プロンプト");
    expect(String(exported.text)).not.toContain("credential_profile_id");
    const row = await env.DB.prepare(
      "SELECT status, ciphertext FROM standby_snapshots WHERE standby_snapshot_id = ?",
    ).bind(standbyId).first<{ status: string; ciphertext: string | null }>();
    expect(row?.status).toBe("ready");
    expect(row?.ciphertext).toBeTruthy();
  });

  it("外部AI export routeはdevice認証を必須にしてno-storeで返す", async () => {
    const suffix = crypto.randomUUID();
    const standby = await registerStandbySnapshot(
      env.DB,
      { home_instance_id: `home-${suffix}`, retention_days: 7, snapshot: snapshot(suffix) },
      KEY,
      "key-1",
      new Date(),
    );
    const path = `/v1/standby-snapshots/${standby.standby_snapshot_id}/external-ai-export`;
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_id: `standby-persona-${suffix}`, disclosure_confirmed: true }),
    };
    const unauthorized = await worker.fetch(new Request(`https://worker.test${path}`, init), env);
    expect(unauthorized.status).toBe(401);
    const device = await pairDevice(suffix);
    const authorized = await worker.fetch(new Request(`https://worker.test${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${device.access_token}` },
    }), env);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("Cache-Control")).toBe("no-store");
    const body = await authorized.json<Record<string, unknown>>();
    expect(String(body.text)).toContain("安全な待機用プロンプト");
    expect(body).not.toHaveProperty("persona_id");
  });

  it("本文を暗号化して安全なmanifestだけを返し、旧readyをsupersedeする", async () => {
    const suffix = crypto.randomUUID();
    const request = { home_instance_id: `home-${suffix}`, retention_days: 7, snapshot: snapshot(suffix) };
    const first = await registerStandbySnapshot(env.DB, request, KEY, "key-1", new Date("2026-07-17T00:00:00Z"));
    const second = await registerStandbySnapshot(env.DB, request, KEY, "key-1", new Date("2026-07-17T01:00:00Z"));
    expect(first).not.toHaveProperty("ciphertext");
    expect(first).not.toHaveProperty("nonce");
    expect(JSON.stringify(first)).not.toContain("安全な待機用プロンプト");
    expect(second).toMatchObject({ generation: 2, status: "ready", persona_count: 1 });
    const rows = await env.DB.prepare(
      "SELECT status, ciphertext, content_delete_after FROM standby_snapshots WHERE home_instance_id = ? ORDER BY generation",
    ).bind(request.home_instance_id).all<{ status: string; ciphertext: string; content_delete_after: string | null }>();
    expect(rows.results.map((row) => row.status)).toEqual(["superseded", "ready"]);
    expect(rows.results[0]?.ciphertext).not.toContain("安全な待機用プロンプト");
    expect(rows.results[0]?.content_delete_after).toBe("2026-07-18T01:00:00.000Z");
  });

  it("recovery_unconfirmedを同じactivation_idで1 sessionだけ作る", async () => {
    const suffix = crypto.randomUUID();
    const standby = await registerStandbySnapshot(
      env.DB,
      { home_instance_id: `home-${suffix}`, retention_days: 7, snapshot: snapshot(suffix) },
      KEY,
      "key-1",
      new Date("2026-07-17T00:00:00Z"),
    );
    const standbyId = String(standby.standby_snapshot_id);
    const body = { activation_id: `activation-${suffix}`, activation_mode: "recovery_unconfirmed" };
    const first = await activateStandbySnapshot(env.DB, standbyId, body, KEY, new Date("2026-07-17T01:00:00Z"));
    const second = await activateStandbySnapshot(env.DB, standbyId, body, KEY, new Date("2026-07-17T01:00:01Z"));
    expect(first).toMatchObject({ duplicate: false, branch_divergence_possible: true });
    expect(second).toMatchObject({ duplicate: true, activated_session_id: first.activated_session_id });
    const activatedStandby = await env.DB.prepare(
      "SELECT ciphertext, nonce, content_deleted_at FROM standby_snapshots WHERE standby_snapshot_id = ?",
    ).bind(standbyId).first<{ ciphertext: string | null; nonce: string | null; content_deleted_at: string | null }>();
    expect(activatedStandby).toMatchObject({ ciphertext: null, nonce: null });
    expect(activatedStandby?.content_deleted_at).toBe("2026-07-17T01:00:00.000Z");
    const sessions = await env.DB.prepare(
      "SELECT activation_mode, branch_divergence_possible FROM travel_sessions WHERE travel_session_id = ?",
    ).bind(first.activated_session_id).all<{ activation_mode: string; branch_divergence_possible: number }>();
    expect(sessions.results).toEqual([{ activation_mode: "recovery_unconfirmed", branch_divergence_possible: 1 }]);
    const persona = await env.DB.prepare(
      "SELECT branch_divergence_possible FROM travel_personas WHERE travel_session_id = ?",
    ).bind(first.activated_session_id).first<{ branch_divergence_possible: number }>();
    expect(persona?.branch_divergence_possible).toBe(1);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO travel_events
         (event_id, travel_session_id, persona_id, sequence_no, type, created_at, content, content_hash, status)
         VALUES (?, ?, ?, 1, 'user_message', ?, '独立モードで追加した質問', 'hash-current-user', 'committed')`,
      ).bind(
        `external-current-user-${suffix}`,
        first.activated_session_id,
        `standby-persona-${suffix}`,
        "2026-07-17T01:01:00Z",
      ),
      env.DB.prepare(
        `INSERT INTO travel_events
         (event_id, travel_session_id, persona_id, sequence_no, type, created_at, content, content_hash, status)
         VALUES (?, ?, ?, 2, 'assistant_message', ?, '独立モードで追加した返答', 'hash-current-assistant', 'committed')`,
      ).bind(
        `external-current-assistant-${suffix}`,
        first.activated_session_id,
        `standby-persona-${suffix}`,
        "2026-07-17T01:01:01Z",
      ),
    ]);
    const exported = await buildActiveSessionExternalAiExport(
      env.DB,
      String(first.activated_session_id),
      `standby-persona-${suffix}`,
      { disclosure_confirmed: true },
    );
    expect(exported).toMatchObject({
      source_label: "独立モードの現在時点",
      travel_event_count: 2,
      current_through_sequence: 2,
      current_through_at: "2026-07-17T01:01:01Z",
    });
    expect(String(exported.text)).toContain("安全な待機用プロンプト");
    expect(String(exported.text)).toContain("[user] 独立モードで追加した質問");
    expect(String(exported.text)).toContain("[AI] 独立モードで追加した返答");
  });

  it("期限切れ待機本文をretentionしactive旅行は削除しない", async () => {
    const suffix = crypto.randomUUID();
    await registerStandbySnapshot(
      env.DB,
      { home_instance_id: `home-${suffix}`, retention_days: 1, snapshot: snapshot(suffix) },
      KEY,
      "key-1",
      new Date("2026-07-01T00:00:00Z"),
    );
    const preview = await retentionPreview(env.DB, "2026-07-03T00:00:00.000Z");
    expect(Number(preview.deleted_standby_count)).toBeGreaterThan(0);
    const run = await runRetention(env.DB, "2026-07-03T00:00:00.000Z", "manual");
    expect(Number(run.deleted_standby_count)).toBeGreaterThan(0);
    expect(await listStandbySnapshots(env.DB, "2026-07-03T00:00:00.000Z")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ home_instance_id: `home-${suffix}`, status: "ready" })]),
    );
  });
});

describe("Phase 5 diagnostics and CORS", () => {
  it("owner診断に本文・token・Secret値を含めない", async () => {
    const result = await ownerDiagnostics(env.DB, "2026-07-17T00:00:00Z", [
      { name: "OWNER_AUTH_TOKEN", configured: true, required: true },
    ]);
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ d1: { d1_schema_version: 10 } });
    expect(serialized).not.toContain("phase1-owner-test-token");
    expect(serialized).not.toContain("phase5-standby-encryption-test-key");
    expect(serialized).not.toContain("snapshot_json");
  });

  it("healthはschema 10を返しstrict CORSは設定originだけを許可する", async () => {
    const allowed = await worker.fetch(new Request("https://worker.test/v1/health", {
      headers: { Origin: "https://lite.test" },
    }), env);
    expect((await allowed.json<Record<string, unknown>>()).api_schema_version).toBe(10);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://lite.test");
    const denied = await worker.fetch(new Request("https://worker.test/v1/health", {
      headers: { Origin: "https://evil.test" },
    }), env);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await worker.fetch(new Request("https://worker.test/v1/standby-snapshots", {
      method: "OPTIONS", headers: { Origin: "https://evil.test" },
    }), env);
    expect(preflight.status).toBe(403);
  });
});
