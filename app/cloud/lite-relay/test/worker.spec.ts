import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { storageCompatibilityState } from "../src/index";

describe("phase0 worker API catalog", () => {
  it("healthがbuildとschemaを返す", async () => {
    const response = await worker.fetch(new Request("https://worker.test/v1/health"), env);
    const body = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("phase0-local");
    expect(body.api_schema_version).toBe(10);
    expect(body.d1_schema_version).toBe(10);
    expect(body.storage_schema_ready).toBe(true);
  });

  it("旧D1でschema表を読めなくてもhealth用互換状態を安全に返す", async () => {
    const unavailable = {
      prepare() {
        throw new Error("no such table: relay_schema_state");
      },
    } as unknown as D1Database;

    await expect(storageCompatibilityState(unavailable)).resolves.toEqual({
      d1_schema_version: null,
      storage_schema_ready: false,
    });

    const response = await worker.fetch(
      new Request("https://worker.test/v1/health"),
      { ...env, DB: unavailable },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      d1_schema_version: null,
      storage_schema_ready: false,
    });
  });

  it("旅行APIを未認証で公開しない", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/travel-sessions/session-api/events?persona_id=persona-api&after_sequence=0"),
      env,
    );
    const body = await response.json<{ error: string }>();
    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("profile別モデル一覧を未認証で公開しない", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/provider-profiles/gemini-personal-1/models"),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("本体所有者もsnapshot前のprofile・モデル経路検証APIを利用できる", async () => {
    const headers = { Authorization: "Bearer phase1-owner-test-token" };
    const profiles = await worker.fetch(
      new Request("https://worker.test/v1/provider-profiles", { headers }),
      env,
    );
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toHaveProperty("profiles");

    const models = await worker.fetch(
      new Request("https://worker.test/v1/provider-profiles/not-registered/models?refresh=1", { headers }),
      env,
    );
    expect(models.status).toBe(409);
    expect(await models.json()).toEqual({ error: "credential_profile_unavailable" });
  });

  it("remote検証endpointをtokenで保護する", async () => {
    const response = await worker.fetch(new Request("https://worker.test/v1/phase0/stream"), env);
    expect(response.status).toBe(401);
  });

  it("不正なrun IDをD1へ渡さない", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/phase0/d1/validate", {
        method: "POST",
        headers: {
          Authorization: "Bearer phase0-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: "INVALID/ID" }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_run_id" });
  });

  it("合成SSEをstreaming契約で返す", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/phase0/stream", {
        headers: { Authorization: "Bearer phase0-test-token" },
      }),
      env,
    );
    const body = await response.text();
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(body).toContain('"text":"PHASE0_"');
    expect(body).toContain('"status":"completed"');
  });

  it("D1のatomic確定・rollback・cursor欠番を検証して削除する", async () => {
    const headers = {
      Authorization: "Bearer phase0-test-token",
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({ run_id: "vitest" });
    const response = await worker.fetch(
      new Request("https://worker.test/v1/phase0/d1/validate", { method: "POST", headers, body }),
      env,
    );
    const result = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.rollback_row_count).toBe(0);
    expect(result.sequences).toEqual([1, 3]);

    const cleanup = await worker.fetch(
      new Request("https://worker.test/v1/phase0/d1/validate", { method: "DELETE", headers, body }),
      env,
    );
    expect(cleanup.status).toBe(200);
  });
});
