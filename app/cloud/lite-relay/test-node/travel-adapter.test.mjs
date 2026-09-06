import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterSource = await readFile(new URL("../../../mobile_app/static/travel-adapter.js", import.meta.url), "utf8");
const adapterModule = await import(`data:text/javascript;base64,${Buffer.from(adapterSource).toString("base64")}`);
const { travelAdapter } = adapterModule;

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function installCredentials() {
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://worker.test",
    "nexusLite.travel.device.accessToken": "expired-access",
    "nexusLite.travel.device.refreshToken": "expired-refresh",
    "nexusLite.travel.device.id": "device-1",
  });
}

test("refreshが401なら待機snapshotなしではなく再ペアリング要求へ分類する", async () => {
  installCredentials();
  globalThis.fetch = async (url) => String(url).endsWith("/v1/devices/refresh")
    ? new Response(JSON.stringify({ error: "device_revoked" }), { status: 401 })
    : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  await assert.rejects(
    travelAdapter.listStandby(),
    (error) => travelAdapter.errorCode(error) === "re_pair_required" && /再ペアリング/.test(error.message),
  );
  assert.equal(travelAdapter.paired(), false);
  assert.equal(localStorage.getItem("nexusLite.travel.device.refreshToken"), null);
});

test("access token期限切れでもrefresh成功後は待機snapshotを取得できる", async () => {
  installCredentials();
  let standbyCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/devices/refresh")) {
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        device_id: "device-1",
      }), { status: 200 });
    }
    standbyCalls += 1;
    return standbyCalls === 1
      ? new Response(JSON.stringify({ error: "access_expired" }), { status: 401 })
      : new Response(JSON.stringify({ snapshots: [{ status: "ready", generation: 5 }] }), { status: 200 });
  };

  const result = await travelAdapter.listStandby();
  assert.equal(result.snapshots[0].generation, 5);
  assert.equal(localStorage.getItem("nexusLite.travel.device.accessToken"), "new-access");
});

test("期限切れaccessへの並行要求でもrefresh tokenを一度だけローテーションする", async () => {
  installCredentials();
  let refreshCalls = 0;
  const authenticatedCalls = new Map();
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/v1/devices/refresh")) {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        device_id: "device-1",
      });
    }
    const path = new URL(value).pathname;
    const count = (authenticatedCalls.get(path) || 0) + 1;
    authenticatedCalls.set(path, count);
    const authorization = new Headers(options.headers).get("Authorization");
    if (authorization === "Bearer expired-access") {
      return Response.json({ error: "access_expired" }, { status: 401 });
    }
    if (path === "/v1/standby-snapshots") {
      return Response.json({ snapshots: [{ status: "ready", generation: 6 }] });
    }
    if (path === "/v1/travel-sessions/current") {
      return Response.json({ session: { status: "active" } });
    }
    return Response.json({ error: "unexpected_path", count }, { status: 500 });
  };

  const [standby, current] = await Promise.all([
    travelAdapter.listStandby(),
    travelAdapter.currentSession(),
  ]);

  assert.equal(refreshCalls, 1);
  assert.equal(standby.snapshots[0].generation, 6);
  assert.equal(current.status, "active");
  assert.equal(localStorage.getItem("nexusLite.travel.device.accessToken"), "new-access");
  assert.equal(localStorage.getItem("nexusLite.travel.device.refreshToken"), "new-refresh");
  assert.equal(travelAdapter.paired(), true);
});

test("refresh通信失敗は再ペアリング要求ではなくWorker接続失敗へ分類する", async () => {
  installCredentials();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/devices/refresh")) throw new TypeError("network down");
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };

  await assert.rejects(
    travelAdapter.listStandby(),
    (error) => travelAdapter.errorCode(error) === "worker_unreachable",
  );
  assert.equal(travelAdapter.paired(), true);
});

test("短期ペアリングコード自体の401は端末失効として誤分類しない", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "pairing_code_invalid" }), { status: 401 });

  await assert.rejects(
    travelAdapter.pair("bad-code", "test-device"),
    (error) => travelAdapter.errorCode(error) === "" && error.message === "pairing_code_invalid",
  );
});

test("Workerが新しければ再ペアリングではなくPWA更新へ分類する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => Response.json({ ok: true, api_schema_version: 11 });

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "pwa_update_required",
    api_schema_version: 11,
  });
});

test("Workerが古ければクラウド更新へ分類する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => Response.json({ ok: true, api_schema_version: 9 });

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "worker_update_required",
    api_schema_version: 9,
  });
});

test("Worker APIが新しくてもD1 schema 10未満ならクラウド更新へ分類する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => Response.json({
    ok: true,
    api_schema_version: 10,
    d1_schema_version: 9,
    storage_schema_ready: false,
  });

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "worker_update_required",
    api_schema_version: 10,
    d1_schema_version: 9,
    storage_schema_ready: false,
  });
});

test("D1 schema 10が準備済みなら通常のhealthを返す", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  const health = {
    ok: true,
    api_schema_version: 10,
    d1_schema_version: 10,
    storage_schema_ready: true,
  };
  globalThis.fetch = async () => Response.json(health);

  assert.deepEqual(await travelAdapter.health(), health);
});

test("通常fetchだけ失敗してno-cors疎通する場合は接続元未許可へ分類する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  const modes = [];
  globalThis.fetch = async (_url, options = {}) => {
    modes.push(options.mode || "cors");
    if (options.mode === "no-cors") return new Response(null, { status: 200 });
    throw new TypeError("Failed to fetch");
  };

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "cors_rejected",
    browser_error: "TypeError",
    browser_message: "Failed to fetch",
  });
  assert.deepEqual(modes, ["cors", "no-cors"]);
});

test("通常fetchとno-corsの両方が失敗した場合は秘密なしの例外要約を返す", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async (_url, options = {}) => {
    if (options.mode === "no-cors") throw new TypeError("fallback blocked\nline");
    throw new TypeError("primary blocked\nline");
  };

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "worker_unreachable",
    browser_error: "TypeError",
    browser_message: "primary blocked line",
    fallback_error: "TypeError",
    fallback_message: "fallback blocked line",
  });
});

test("healthのJSONを読めない場合はHTTP応答を回線断と区別する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => new Response("not json", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  const result = await travelAdapter.health();
  assert.equal(result.ok, false);
  assert.equal(result.error, "worker_invalid_response");
  assert.equal(result.http_status, 200);
  assert.equal(result.content_type, "text/html");
  assert.equal(result.browser_error, "SyntaxError");
});

test("healthにschemaがない場合はHTTP応答を回線断と区別する", async () => {
  globalThis.localStorage = new MemoryStorage({ "nexusLite.travel.apiBase": "https://worker.test" });
  globalThis.fetch = async () => Response.json({ ok: true });

  assert.deepEqual(await travelAdapter.health(), {
    ok: false,
    error: "worker_invalid_response",
    http_status: 200,
    content_type: "application/json",
    api_schema_version: undefined,
  });
});

test("統合Liteはペルソナ別経路・モデル一覧・利用額APIを使い分ける", async () => {
  installCredentials();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body || "" });
    if (String(url).includes("/models")) {
      return Response.json({ source: "live", models: [{ model_id: "safe-model", available: true }] });
    }
    if (String(url).endsWith("/route")) {
      return Response.json({ changed: true, route: { model_id: "safe-model", route_epoch: 1 } });
    }
    if (String(url).includes("/usage-summary")) {
      return Response.json({ known_cost_usd: 0.01 });
    }
    return Response.json({ profiles: [{ credential_profile_id: "profile-1", enabled: true }] });
  };
  const session = { travel_session_id: "session-1", personas: [{ persona_id: "persona-a" }] };

  await travelAdapter.providerProfiles();
  await travelAdapter.models("profile-1", true);
  await travelAdapter.changeRoute(session, "persona-a", "profile-1", "safe-model");
  await travelAdapter.usageSummary(session, "persona-a");

  assert.equal(requests[0].url, "https://worker.test/v1/provider-profiles");
  assert.equal(requests[1].url, "https://worker.test/v1/provider-profiles/profile-1/models?refresh=1");
  assert.match(
    requests[2].url,
    /\/v1\/travel-sessions\/session-1\/personas\/persona-a\/route$/,
  );
  assert.equal(requests[2].method, "PUT");
  const routeBody = JSON.parse(requests[2].body);
  assert.match(routeBody.route_change_id, /^[A-Za-z0-9_]{8,100}$/);
  assert.deepEqual({
    credential_profile_id: routeBody.credential_profile_id,
    model_id: routeBody.model_id,
  }, {
    credential_profile_id: "profile-1",
    model_id: "safe-model",
  });
  assert.equal(
    requests[3].url,
    "https://worker.test/v1/travel-sessions/session-1/usage-summary?persona_id=persona-a",
  );
});

test("外部AI文面は明示POSTで取得しbrowser storageへ保存しない", async () => {
  installCredentials();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body || "" });
    return Response.json({ text: "safe prompt", content_chars: 11 });
  };

  const standby = await travelAdapter.externalAiExportFromStandby("standby / 1", "persona / a");
  const active = await travelAdapter.externalAiExportFromSession("session / 1", "persona / a");

  assert.equal(standby.text, "safe prompt");
  assert.equal(active.text, "safe prompt");
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, /standby%20%2F%201\/external-ai-export$/);
  assert.match(requests[1].url, /session%20%2F%201\/personas\/persona%20%2F%20a\/external-ai-export$/);
  assert.equal(JSON.parse(requests[0].body).disclosure_confirmed, true);
  assert.equal(localStorage.getItem("nexusLite.externalAiExport"), null);
});
