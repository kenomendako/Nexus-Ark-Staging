import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterSource = await readFile(new URL("../../../mobile_app/static/travel-adapter.js", import.meta.url), "utf8");
let moduleRevision = 0;

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

async function loadAdapter() {
  moduleRevision += 1;
  const source = Buffer.from(adapterSource).toString("base64");
  return import(`data:text/javascript;base64,${source}#lite-send-failure-${moduleRevision}`);
}

function installCredentials(entries = {}) {
  globalThis.localStorage = new MemoryStorage({
    "nexusLite.travel.apiBase": "https://worker.test",
    "nexusLite.travel.device.accessToken": "access-1",
    "nexusLite.travel.device.refreshToken": "refresh-1",
    "nexusLite.travel.device.id": "device-1",
    ...entries,
  });
}

function eventStream(events) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function assertFailureShape(failure, code, httpStatus) {
  assert.ok(failure);
  assert.deepEqual(Object.keys(failure).sort(), ["code", "httpStatus", "message"]);
  assert.equal(failure.code, code);
  assert.equal(failure.httpStatus, httpStatus);
  assert.equal(typeof failure.message, "string");
  assert.ok(failure.message.length > 0);
}

async function seedHttpFailure(travelAdapter, clientMessageId = "seed-client-id") {
  globalThis.fetch = async () => Response.json({
    error: "provider_auth_failed",
    safe_message_ja: "SAFE_UPSTREAM_SENTINEL",
    provider_code: "RAW_PROVIDER_SENTINEL",
    message: "RAW_MESSAGE_SENTINEL",
  }, { status: 502 });

  await assert.rejects(
    travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "送信本文",
      clientMessageId,
    ),
    (error) => travelAdapter.errorCode(error) === "provider_auth_failed"
      && travelAdapter.httpStatus(error) === 502,
  );
}

test("HTTP送信失敗は許可された分類とHTTPだけを公開し、未知codeはfallbackになる", async () => {
  const cases = [
    { upstreamCode: "provider_auth_failed", expectedCode: "provider_auth_failed", status: 502 },
    { upstreamCode: "provider_rate_limited", expectedCode: "provider_rate_limited", status: 429 },
    { upstreamCode: "provider_secret_unknown", expectedCode: "travel_send_failed", status: 503 },
    { upstreamCode: { message: "RAW_MESSAGE_SENTINEL" }, expectedCode: "travel_send_failed", status: 503 },
  ];

  for (const [index, current] of cases.entries()) {
    const { travelAdapter, TravelAdapterError } = await loadAdapter();
    installCredentials();
    globalThis.fetch = async (url, init = {}) => {
      assert.match(String(url), /\/v1\/travel-sessions\/session-1\/messages$/);
      assert.equal(init.method, "POST");
      return Response.json({
        error: current.upstreamCode,
        safe_message_ja: "SAFE_UPSTREAM_SENTINEL",
        provider_code: "RAW_PROVIDER_SENTINEL",
        message: "RAW_MESSAGE_SENTINEL",
        detail: "RAW_TOKEN_SENTINEL",
      }, { status: current.status });
    };

    await assert.rejects(
      travelAdapter.send(
        { travel_session_id: "session-1" },
        "persona-1",
        "USER_MESSAGE_SENTINEL",
        `http-failure-${index}-client`,
      ),
      (error) => {
        assert.ok(error instanceof TravelAdapterError);
        assert.equal(travelAdapter.errorCode(error), current.expectedCode);
        assert.equal(travelAdapter.httpStatus(error), current.status);
        assert.doesNotMatch(error.message, /SAFE_UPSTREAM_SENTINEL|RAW_MESSAGE_SENTINEL|RAW_TOKEN_SENTINEL/);
        return true;
      },
    );

    const stored = JSON.parse(localStorage.getItem(travelAdapter.keys.lastSendFailure));
    assert.equal(stored.code, current.expectedCode);
    assert.equal(stored.http_status, current.status);
    assert.equal(Object.hasOwn(stored, "message"), false);
    assert.equal(Object.hasOwn(stored, "safe_message_ja"), false);
    assert.equal(Object.hasOwn(stored, "provider_code"), false);
    assert.equal(Object.hasOwn(stored, "error"), false);
    assert.doesNotMatch(JSON.stringify(stored), /SAFE_UPSTREAM_SENTINEL|RAW_MESSAGE_SENTINEL|RAW_TOKEN_SENTINEL/);
    assert.equal(travelAdapter.inspectPending().state, "pending");
  }
});

test("SSE response.errorはcategoryを安全なresult.errorへ正規化する", async () => {
  const cases = [
    ["auth", "provider_auth_failed", 502],
    ["rate_limit", "provider_rate_limited", 429],
    ["invalid_request", "provider_rejected_request", 422],
    ["model_unavailable", "provider_model_unavailable", 409],
    ["stream_interrupted", "stream_interrupted", 499],
    ["output_limit", "output_limit", 413],
  ];

  for (const [index, [category, expectedCode, httpStatus]] of cases.entries()) {
    const { travelAdapter } = await loadAdapter();
    installCredentials();
    globalThis.fetch = async () => eventStream([{
      type: "response.error",
      error: {
        category,
        http_status: httpStatus,
        provider_code: "RAW_PROVIDER_SENTINEL",
        safe_message_ja: "SAFE_UPSTREAM_SENTINEL",
        message: "RAW_MESSAGE_SENTINEL",
      },
    }]);

    const result = await travelAdapter.send(
      { travel_session_id: "session-1" },
      "persona-1",
      "送信本文",
      `sse-failure-${index}-client`,
    );

    assert.equal(result.terminal, "response.error");
    assertFailureShape(result.error, expectedCode, httpStatus);
    assert.doesNotMatch(JSON.stringify(result), /RAW_PROVIDER_SENTINEL|SAFE_UPSTREAM_SENTINEL|RAW_MESSAGE_SENTINEL/);
    assert.equal(travelAdapter.inspectPending().state, "pending");
    const stored = JSON.parse(localStorage.getItem(travelAdapter.keys.lastSendFailure));
    assert.equal(stored.code, expectedCode);
    assert.equal(stored.http_status, httpStatus);
    assert.doesNotMatch(JSON.stringify(stored), /RAW_PROVIDER_SENTINEL|SAFE_UPSTREAM_SENTINEL|RAW_MESSAGE_SENTINEL/);
  }
});

test("lastSendFailureは現在のWorker・session・personaだけに一致し、モジュール再読込後も読める", async () => {
  const { travelAdapter } = await loadAdapter();
  installCredentials();
  await seedHttpFailure(travelAdapter, "scoped-failure-client");

  const session = { travel_session_id: "session-1" };
  const currentFailure = travelAdapter.lastSendFailure(session, "persona-1");
  assertFailureShape(currentFailure, "provider_auth_failed", 502);
  assert.equal(travelAdapter.lastSendFailure({ travel_session_id: "other-session" }, "persona-1"), null);
  assert.equal(travelAdapter.lastSendFailure(session, "other-persona"), null);

  const reloaded = (await loadAdapter()).travelAdapter;
  assert.deepEqual(reloaded.lastSendFailure(session, "persona-1"), currentFailure);
  reloaded.configure("https://other-worker.test");
  assert.equal(reloaded.lastSendFailure(session, "persona-1"), null);
});

test("failed_knownとpartialの照会はpendingだけを解除し、lastSendFailureを残す", async () => {
  for (const status of ["failed_known", "partial"]) {
    const { travelAdapter } = await loadAdapter();
    installCredentials();
    const clientMessageId = `final-${status}-client`;
    await seedHttpFailure(travelAdapter, clientMessageId);

    globalThis.fetch = async (url, init = {}) => {
      assert.match(String(url), /\/v1\/message-requests\//);
      assert.equal(init.method || "GET", "GET");
      return Response.json({
        client_message_id: clientMessageId,
        travel_session_id: "session-1",
        persona_id: "persona-1",
        status,
      });
    };

    assert.equal(await travelAdapter.pendingStatus(), null);
    assert.equal(travelAdapter.inspectPending().state, "none");
    assertFailureShape(
      travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"),
      "provider_auth_failed",
      502,
    );
  }
});

test("outcome_unknownとprovider_startedの照会はpendingとlastSendFailureを保護する", async () => {
  for (const status of ["outcome_unknown", "provider_started"]) {
    const { travelAdapter } = await loadAdapter();
    installCredentials();
    const clientMessageId = `open-${status}-client`;
    await seedHttpFailure(travelAdapter, clientMessageId);

    globalThis.fetch = async () => Response.json({
      client_message_id: clientMessageId,
      travel_session_id: "session-1",
      persona_id: "persona-1",
      status,
    });

    const remote = await travelAdapter.pendingStatus();
    assert.equal(remote.status, status);
    assert.equal(travelAdapter.inspectPending().state, "pending");
    assertFailureShape(
      travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"),
      "provider_auth_failed",
      502,
    );
  }
});

test("committed成功だけが該当するfailureとpendingを解除する", async () => {
  const { travelAdapter } = await loadAdapter();
  installCredentials();
  let postCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/v1/message-requests/")) {
      return Response.json({
        client_message_id: "committed-seed-client",
        travel_session_id: "session-1",
        persona_id: "persona-1",
        status: "failed_known",
      });
    }
    assert.match(value, /\/v1\/travel-sessions\/session-1\/messages$/);
    assert.equal(init.method, "POST");
    postCount += 1;
    if (postCount === 1) {
      return Response.json({
        error: "provider_auth_failed",
        safe_message_ja: "SAFE_UPSTREAM_SENTINEL",
        provider_code: "RAW_PROVIDER_SENTINEL",
      }, { status: 502 });
    }
    return eventStream([{ type: "response.committed" }]);
  };

  await assert.rejects(
    travelAdapter.send({ travel_session_id: "session-1" }, "persona-1", "最初の送信", "committed-seed-client"),
    (error) => travelAdapter.errorCode(error) === "provider_auth_failed"
      && travelAdapter.httpStatus(error) === 502,
  );
  assert.equal(travelAdapter.inspectPending().state, "pending");
  assertFailureShape(
    travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"),
    "provider_auth_failed",
    502,
  );

  const result = await travelAdapter.send(
    { travel_session_id: "session-1" },
    "persona-1",
    "成功する送信",
    "committed-final-client",
  );
  assert.equal(result.terminal, "response.committed");
  assert.equal(travelAdapter.inspectPending().state, "none");
  assert.equal(localStorage.getItem(travelAdapter.keys.lastSendFailure), null);
  assert.equal(travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"), null);
});

test("通信・本文読込の失敗も理由を保持し、確定照会までpendingを消さない", async () => {
  for (const code of ["worker_unreachable", "stream_interrupted"]) {
    const { travelAdapter } = await loadAdapter();
    installCredentials();
    let posts = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/v1/message-requests/")) {
        return Response.json({ client_message_id: "transport-client", travel_session_id: "session-1",
          persona_id: "persona-1", status: "failed_known" });
      }
      posts++;
      if (code === "worker_unreachable") throw new TypeError("PRIVATE_NETWORK_ERROR");
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_READ_ERROR")); } }));
    };
    await assert.rejects(travelAdapter.send({ travel_session_id: "session-1" }, "persona-1", "PRIVATE_MESSAGE", "transport-client"),
      (error) => travelAdapter.errorCode(error) === code && !/PRIVATE_/.test(error.message));
    assert.equal(travelAdapter.inspectPending().state, "pending");
    assertFailureShape(travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"), code, 0);
    assert.equal(await travelAdapter.pendingStatus(), null);
    assertFailureShape(travelAdapter.lastSendFailure({ travel_session_id: "session-1" }, "persona-1"), code, 0);
    assert.equal(posts, 1);
  }
});

test("送信応答の読込中に接続先が変わったら旧failureを新接続へ保存しない", async () => {
  for (const kind of ["http", "sse"]) {
    const { travelAdapter } = await loadAdapter();
    installCredentials();
    globalThis.fetch = async () => ({
      ok: kind === "sse", status: kind === "sse" ? 200 : 502,
      async json() { travelAdapter.configure("https://other-worker.test"); return { error: "provider_auth_failed" }; },
      async text() { travelAdapter.configure("https://other-worker.test"); return 'data: {"type":"response.error","error":{"category":"auth"}}\n\n'; },
    });
    await assert.rejects(travelAdapter.send({ travel_session_id: "session-1" }, "persona-1", "message", "changed-origin-client"),
      (error) => travelAdapter.errorCode(error) === "pending_origin_mismatch");
    assert.equal(localStorage.getItem(travelAdapter.keys.lastSendFailure), null);
    assert.equal(travelAdapter.inspectPending().pending.worker_url, "https://worker.test");
  }
});
