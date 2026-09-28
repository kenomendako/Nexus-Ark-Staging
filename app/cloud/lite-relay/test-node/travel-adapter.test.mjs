import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterSource = await readFile(new URL("../../../mobile_app/static/travel-adapter.js", import.meta.url), "utf8");
Error.stackTraceLimit = 0;
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
    (error) => travelAdapter.errorCode(error) === "pairing_code_invalid" && error.message === "pairing_code_invalid",
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


function installPendingMessage(overrides = {}) {
  installCredentials();
  localStorage.setItem("nexusLite.travel.pendingMessage", JSON.stringify({
    client_message_id: "old-client-id",
    session_id: "session-1",
    persona_id: "persona-1",
    message: "前回の送信",
    ...overrides,
  }));
}

test("結果未確定のpendingは新規sendで上書きせず保持する", async () => {
  installPendingMessage();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return Response.json({
      client_message_id: "old-client-id",
      travel_session_id: "session-1",
      persona_id: "persona-1",
      status: "outcome_unknown",
    });
  };

  await assert.rejects(
    travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "新しい送信",
      "new-client-id",
    ),
    (error) => travelAdapter.errorCode(error) === "pending_send_unresolved",
  );
  assert.deepEqual(JSON.parse(localStorage.getItem("nexusLite.travel.pendingMessage")), {
    client_message_id: "old-client-id",
    session_id: "session-1",
    persona_id: "persona-1",
    message: "前回の送信",
  });
  assert.deepEqual(requests.map(({ method }) => method), ["GET"]);
});

test("pending照会の通信失敗でもpendingを保持し新規sendを止める", async () => {
  installPendingMessage();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    throw new TypeError("network down");
  };

  await assert.rejects(
    travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "新しい送信",
      "new-client-id",
    ),
    (error) => travelAdapter.errorCode(error) === "worker_unreachable",
  );
  assert.equal(JSON.parse(localStorage.getItem("nexusLite.travel.pendingMessage")).client_message_id, "old-client-id");
  assert.deepEqual(requests.map(({ method }) => method), ["GET"]);
});

test("確定済みpendingは照会後に解放して新規sendを許可する", async () => {
  installPendingMessage();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || "GET" };
    requests.push(request);
    if (request.url.includes("/v1/message-requests/")) {
      return Response.json({ client_message_id: "old-client-id", travel_session_id: "session-1", persona_id: "persona-1", status: "failed_known" });
    }
    return new Response('data: {"type":"response.committed"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const result = await travelAdapter.send(
    { travel_session_id: "session-1" },
    "persona-1",
    "新しい送信",
    "new-client-id",
  );

  assert.equal(result.terminal, "response.committed");
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), null);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST"]);
});

test("壊れたpending保存値は照会せず保持して新規sendを止める", async () => {
  installCredentials();
  localStorage.setItem("nexusLite.travel.pendingMessage", "{");
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  await assert.rejects(
    travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "新しい送信",
      "new-client-id",
    ),
    (error) => travelAdapter.errorCode(error) === "pending_send_unresolved",
  );
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), "{");
  assert.equal(fetchCalls, 0);
});


test("同一画面の同時send再入でもpendingを上書きしない", async () => {
  installCredentials();
  let postCalls = 0;
  let releasePost;
  let notifyPostStarted;
  const postStarted = new Promise((resolve) => { notifyPostStarted = resolve; });
  const postRelease = new Promise((resolve) => { releasePost = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/travel-sessions/")) {
      postCalls += 1;
      notifyPostStarted();
      await postRelease;
      return new Response('data: {"type":"response.committed"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error("unexpected request");
  };

  const first = travelAdapter.send(
    { travel_session_id: "session-1" },
    "persona-1",
    "最初の送信",
    "first-client-id",
  );
  await postStarted;
  await assert.rejects(
    travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "同時の送信",
      "second-client-id",
    ),
    (error) => travelAdapter.errorCode(error) === "pending_send_unresolved",
  );
  releasePost();
  await first;
  assert.equal(postCalls, 1);
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), null);
});


test("確定pendingの削除は照会前のclient_message_idを上書きしない", async () => {
  installPendingMessage();
  globalThis.fetch = async () => {
    localStorage.setItem("nexusLite.travel.pendingMessage", JSON.stringify({
      client_message_id: "newer-client-id",
      session_id: "session-1",
      persona_id: "persona-1",
      message: "別タブの送信",
    }));
    return Response.json({ client_message_id: "old-client-id", travel_session_id: "session-1", persona_id: "persona-1", status: "completed" });
  };

  await assert.rejects(travelAdapter.pendingStatus(), (error) => error.code === "pending_changed");
  assert.equal(
    JSON.parse(localStorage.getItem("nexusLite.travel.pendingMessage")).client_message_id,
    "newer-client-id",
  );
});


test("送信完了後に別要求のpendingを削除しない", async () => {
  installCredentials();
  localStorage.removeItem("nexusLite.travel.pendingMessage");
  globalThis.fetch = async () => {
    localStorage.setItem("nexusLite.travel.pendingMessage", JSON.stringify({ client_message_id: "other-id" }));
    return new Response('data: {"type":"response.committed"}\n\n', {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  await assert.rejects(travelAdapter.send({ travel_session_id: "session-1" }, "persona-1", "送信", "my-id"), (error) => error.code === "pending_changed");
  assert.equal(JSON.parse(localStorage.getItem("nexusLite.travel.pendingMessage")).client_message_id, "other-id");
});


test("inspectPendingは未保存ならnoneを返す", () => {
  globalThis.localStorage = new MemoryStorage();
  assert.deepEqual(travelAdapter.inspectPending(), {
    state: "none",
    pending: null,
    raw: null,
  });
});

test("legacy pendingは純読取表示を維持し、従来どおりWorker照会する", async () => {
  const raw = JSON.stringify({
    client_message_id: "legacy-client-id",
    session_id: "session-1",
    persona_id: "persona-1",
    message: "旧形式の送信",
  });
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://worker.test",
    "nexusLite.travel.pendingMessage": raw,
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({
      client_message_id: "legacy-client-id",
      travel_session_id: "session-1", persona_id: "persona-1",
      status: "outcome_unknown",
    });
  };

  assert.deepEqual(travelAdapter.inspectPending(), {
    state: "pending",
    pending: JSON.parse(raw),
    raw,
  });
  assert.deepEqual(await travelAdapter.pendingStatus(), {
    client_message_id: "legacy-client-id",
    travel_session_id: "session-1", persona_id: "persona-1",
    status: "outcome_unknown",
  });
  assert.equal(fetchCalls, 1);
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), raw);
});

test("inspectPendingは壊れたJSONを削除せずcorruptとして返す", async () => {
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://worker.test",
    "nexusLite.travel.pendingMessage": "{broken",
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  assert.deepEqual(travelAdapter.inspectPending(), {
    state: "corrupt",
    pending: null,
    raw: "{broken",
  });
  await assert.rejects(
    travelAdapter.pendingStatus(),
    (error) => travelAdapter.errorCode(error) === "pending_send_unresolved",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), "{broken");
});

test("新規pendingはWorker接続先・端末ID・作成時刻を保存する", async () => {
  installCredentials();
  let savedPending = null;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/travel-sessions/")) {
      savedPending = travelAdapter.inspectPending();
      return new Response('data: {"type":"response.partial"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error("unexpected request");
  };

  const result = await travelAdapter.send(
    { travel_session_id: "session-1" },
    "persona-1",
    "新しい送信",
    "new-client-id",
  );

  assert.equal(result.terminal, "response.partial");
  assert.equal(savedPending?.state, "pending");
  assert.deepEqual(
    {
      client_message_id: savedPending.pending.client_message_id,
      session_id: savedPending.pending.session_id,
      persona_id: savedPending.pending.persona_id,
      message: savedPending.pending.message,
      worker_url: savedPending.pending.worker_url,
      device_id: savedPending.pending.device_id,
    },
    {
      client_message_id: "new-client-id",
      session_id: "session-1",
      persona_id: "persona-1",
      message: "新しい送信",
      worker_url: "https://worker.test",
      device_id: "device-1",
    },
  );
  assert.equal(Number.isFinite(Date.parse(savedPending.pending.created_at)), true);
});

test("接続先変更時は資格情報だけを消しpendingを保持する", () => {
  const pendingRaw = JSON.stringify({
    client_message_id: "old-client-id",
    session_id: "session-1",
    persona_id: "persona-1",
    message: "接続先変更前",
    worker_url: "https://old-worker.test",
  });
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://old-worker.test/",
    "nexusLite.travel.device.accessToken": "old-access",
    "nexusLite.travel.device.refreshToken": "old-refresh",
    "nexusLite.travel.device.id": "old-device",
    "nexusLite.travel.pendingMessage": pendingRaw,
  });

  travelAdapter.configure("https://new-worker.test/");

  assert.equal(travelAdapter.configuredBase(), "https://new-worker.test");
  assert.equal(localStorage.getItem("nexusLite.travel.device.accessToken"), null);
  assert.equal(localStorage.getItem("nexusLite.travel.device.refreshToken"), null);
  assert.equal(localStorage.getItem("nexusLite.travel.device.id"), null);
  assert.equal(localStorage.getItem("nexusLite.travel.pendingMessage"), pendingRaw);
});

test("末尾slashだけの同一接続先再設定では資格情報を保持する", () => {
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://worker.test",
    "nexusLite.travel.device.accessToken": "access",
    "nexusLite.travel.device.refreshToken": "refresh",
    "nexusLite.travel.device.id": "device-1",
  });

  travelAdapter.configure("https://worker.test/");

  assert.equal(localStorage.getItem("nexusLite.travel.device.accessToken"), "access");
  assert.equal(localStorage.getItem("nexusLite.travel.device.refreshToken"), "refresh");
  assert.equal(localStorage.getItem("nexusLite.travel.device.id"), "device-1");
});

test("pendingの接続先不一致は照会せず専用codeで停止する", async () => {
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://new-worker.test",
    "nexusLite.travel.pendingMessage": JSON.stringify({
      client_message_id: "old-client-id",
      session_id: "session-1",
      persona_id: "persona-1",
      message: "旧接続先の送信",
      worker_url: "https://old-worker.test",
      device_id: "old-device",
      created_at: "2026-09-14T00:00:00.000Z",
    }),
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  await assert.rejects(
    travelAdapter.pendingStatus(),
    (error) => travelAdapter.errorCode(error) === "pending_origin_mismatch",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.parse(localStorage.getItem("nexusLite.travel.pendingMessage")).worker_url, "https://old-worker.test");
});

test("Workerの既存error codeをstatus付きadapter例外へ分類する", async () => {
  installCredentials();
  globalThis.fetch = async () => Response.json(
    { error: "message_request_not_found", detail: "secret-token-must-not-be-shown" },
    { status: 404 },
  );

  await assert.rejects(
    travelAdapter.listStandby(),
    (error) => (
      travelAdapter.errorCode(error) === "message_request_not_found"
      && error.status === 404
      && error.message === "message_request_not_found"
      && !error.message.includes("secret-token")
    ),
  );
});

test("未知形式のWorker error本文はrawを表示せずfallback codeにする", async () => {
  installCredentials();
  globalThis.fetch = async () => Response.json(
    { error: "secret-token=do-not-display\nraw body" },
    { status: 500 },
  );

  await assert.rejects(
    travelAdapter.listStandby(),
    (error) => (
      travelAdapter.errorCode(error) === "worker_request_failed"
      && error.status === 500
      && error.message === "worker_request_failed"
      && !error.message.includes("secret-token")
    ),
  );
});

function installReviewPending() {
  installPendingMessage({ worker_url: "https://worker.test" });
  return localStorage.getItem(travelAdapter.keys.pending);
}
function pendingResponse(overrides = {}) {
  return Response.json({ client_message_id: "old-client-id", travel_session_id: "session-1",
    persona_id: "persona-1", status: "outcome_unknown", ...overrides });
}
test("結果不明は再照会と明示確認後に原文を保管しGETだけで待機解除する", async () => {
  const raw = installReviewPending();
  const methods = [];
  globalThis.fetch = async (_url, init) => { methods.push(init.method || "GET"); return pendingResponse(); };
  await travelAdapter.archivePending(raw, { mode: "unknown", confirmed: true });
  assert.equal(localStorage.getItem(travelAdapter.keys.pending), null);
  assert.equal(travelAdapter.listPendingArchive()[0].raw, raw);
  assert.deepEqual(methods, ["GET"]);
  travelAdapter.clear();
  assert.equal(travelAdapter.listPendingArchive().length, 1);
});

for (const [name, options, response, code] of [
  ["未同意", {mode:"unknown",confirmed:false}, {}, "pending_confirmation_required"],
  ["処理中", {mode:"unknown",confirmed:true}, {status:"provider_started"}, "pending_send_unresolved"],
  ["予約中", {mode:"unknown",confirmed:true}, {status:"reserved"}, "pending_send_unresolved"],
  ["別要求", {mode:"unknown",confirmed:true}, {client_message_id:"other"}, "pending_identity_mismatch"],
  ["別session", {mode:"unknown",confirmed:true}, {travel_session_id:"other"}, "pending_identity_mismatch"],
  ["別persona", {mode:"unknown",confirmed:true}, {persona_id:"other"}, "pending_identity_mismatch"],
]) {
  test(name+"では保管せず元pendingを維持する", async () => {
    const raw = installReviewPending();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return pendingResponse(response); };
    await assert.rejects(travelAdapter.archivePending(raw,options), (error) => error.code === code);
    assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
    assert.deepEqual(travelAdapter.listPendingArchive(),[]);
    if (!options.confirmed) assert.equal(calls,0);
  });
}
test("404とlegacyの接続先不明を結果不明の確認で解除しない", async () => {
  let raw = installReviewPending();
  globalThis.fetch = async () => Response.json({error:"not_found"},{status:404});
  await assert.rejects(travelAdapter.archivePending(raw,{mode:"unknown",confirmed:true}), e=>e.status===404);
  installPendingMessage();
  raw = localStorage.getItem(travelAdapter.keys.pending);
  await assert.rejects(travelAdapter.archivePending(raw,{mode:"unknown",confirmed:true}), e=>e.code==="pending_identity_mismatch");
  assert.equal(localStorage.getItem(travelAdapter.keys.pending), raw);
});
test("本体復旧の明示確認で破損した空文字も通信せず保管する", async () => {
  installCredentials();
  localStorage.setItem(travelAdapter.keys.pending,"");
  globalThis.fetch = async () => { throw new Error("通信してはいけない"); };
  await travelAdapter.archivePending("",{mode:"home_recovered",confirmed:true});
  assert.equal(travelAdapter.listPendingArchive()[0].raw,"");
  assert.equal(travelAdapter.inspectPending().state,"none");
});
test("照会中に同じIDの本文が変わっても元の確認で消さない", async () => {
  const raw = installReviewPending();
  const newer = raw.replace("前回の送信","別タブの内容");
  globalThis.fetch = async () => { localStorage.setItem(travelAdapter.keys.pending,newer); return pendingResponse(); };
  await assert.rejects(travelAdapter.archivePending(raw,{mode:"unknown",confirmed:true}), e=>e.code==="pending_changed");
  assert.equal(localStorage.getItem(travelAdapter.keys.pending),newer);
  assert.deepEqual(travelAdapter.listPendingArchive(),[]);
});
test("保管時の容量不足でも元pendingを維持する", async () => {
  const raw=installReviewPending();
  const save=localStorage.setItem.bind(localStorage);
  localStorage.setItem=(key,value)=>{ if(key===travelAdapter.keys.pendingArchive)throw new Error("quota"); save(key,value); };
  await assert.rejects(travelAdapter.archivePending(raw,{mode:"home_recovered",confirmed:true}), e=>e.code==="pending_archive_failed");
  assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
});
for (const variant of ["corrupt","full"]) {
  test("archive "+variant+"なら保管元を削除しない",async()=>{
    const raw=installReviewPending();
    const archive=variant==="corrupt" ? "{" : JSON.stringify(Array.from({length:100},(_,i)=>({
      raw:"record-"+i, review_id:String(i), reviewed_at:"2026-09-14T00:00:00Z", mode:"unknown",worker_url:"https://worker.test"
    })));
    localStorage.setItem(travelAdapter.keys.pendingArchive,archive);
    await assert.rejects(travelAdapter.archivePending(raw,{mode:"home_recovered",confirmed:true}), e=>e.code==="pending_archive_"+variant);
    assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
    assert.equal(localStorage.getItem(travelAdapter.keys.pendingArchive),archive);
  });
}
test("保管後の削除失敗から再試行しても重複保管しない",async()=>{
  const raw=installReviewPending();
  const remove=localStorage.removeItem.bind(localStorage);
  localStorage.removeItem=()=>{throw new Error("blocked");};
  await assert.rejects(travelAdapter.archivePending(raw,{mode:"home_recovered",confirmed:true}));
  assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
  localStorage.removeItem=remove;
  await travelAdapter.archivePending(raw,{mode:"home_recovered",confirmed:true});
  assert.equal(travelAdapter.listPendingArchive().length,1);
});
test("Web Locksを他タブが保持していたら照会も保管もしない",async()=>{
  const raw=installReviewPending();
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"navigator");
  const requests=[];
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{locks:{request:async(name,options,callback)=>{
    requests.push({name,options}); return callback(null);
  }}}});
  try {
    globalThis.fetch=async()=>{throw new Error("通信不可");};
    for(const operation of [
      ()=>travelAdapter.pendingStatus(),
      ()=>travelAdapter.archivePending(raw,{mode:"home_recovered",confirmed:true}),
      ()=>travelAdapter.send({travel_session_id:"session-1"},"persona-1","new","new"),
    ]) await assert.rejects(operation(),e=>e.code==="pending_send_unresolved");
    assert.equal(requests.length,3);
    assert.ok(requests.every(r=>r.options.ifAvailable===true&&r.name==="nexusLite.travel.pending"));
    assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
  } finally {
    if(descriptor)Object.defineProperty(globalThis,"navigator",descriptor);
    else delete globalThis.navigator;
  }
});
test("別接続先へ変更した後の401は新接続先へretryしない",async()=>{
  installCredentials();
  const requests=[];
  globalThis.fetch=async(url)=>{
    requests.push(String(url)); travelAdapter.configure("https://other.test");
    return Response.json({error:"unauthorized"},{status:401});
  };
  await assert.rejects(travelAdapter.listStandby(),e=>e.code==="pending_origin_mismatch");
  assert.equal(requests.length,1);
  assert.equal(travelAdapter.paired(),false);
});
test("refresh応答中に接続先が変わっても旧認証を新接続先に保存しない",async()=>{
  installCredentials();
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith("/refresh")){
      travelAdapter.configure("https://other.test");
      return Response.json({access_token:"old-worker-access",refresh_token:"old-worker-refresh",device_id:"old"});
    }
    return Response.json({error:"expired"},{status:401});
  };
  await assert.rejects(travelAdapter.listStandby(),e=>e.code==="pending_origin_mismatch");
  assert.equal(travelAdapter.paired(),false);
  assert.equal(localStorage.getItem(travelAdapter.keys.refresh),null);
});
test("照会応答が来る前に接続先が変わると確定結果でもpendingを維持する",async()=>{
  const raw=installReviewPending();
  globalThis.fetch=async()=>{travelAdapter.configure("https://other.test");return pendingResponse({status:"completed"});};
  await assert.rejects(travelAdapter.pendingStatus(),e=>e.code==="pending_origin_mismatch");
  assert.equal(localStorage.getItem(travelAdapter.keys.pending),raw);
});
