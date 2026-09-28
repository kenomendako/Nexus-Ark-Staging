import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../../../mobile_app/static/app.js", import.meta.url), "utf8");

function extractFunction(source, declaration, nextDeclaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf(nextDeclaration, start);
  assert.notEqual(start, -1, declaration + " was not found");
  assert.notEqual(end, -1, nextDeclaration + " was not found");
  return source.slice(start, end);
}

function createHarness({ els, travelAdapter, state, setConnectivityStep, window, probeHome, api }) {
  const renderPairing = extractFunction(
    appSource,
    "function renderTravelPairingState(",
    "function isInstalledDisplayMode(",
  );
  const refreshReadiness = extractFunction(
    appSource,
    "async function refreshTravelReadiness()",
    "function setExternalAiExportSource(",
  );
  const returnHome = extractFunction(
    appSource,
    "async function returnTravelToHome()",
    "async function handleHomeModeAction(",
  );
  const factory = new Function(
    "els",
    "travelAdapter",
    "state",
    "setConnectivityStep",
    "renderSnapshotFreshness",
    "setExternalAiExportSource",
    "applyTravelSessionControls",
    "travelSessionBlocksStandby",
    "travelSessionStatus",
    "liteContinuityState",
    "rememberLatestStandby",
    "forgetLatestStandby",
    "snapshotAgeLabel",
    "workerFailureDiagnostic",
    "window",
    "probeHome",
    "api",
    "enterHomeMode",
    "setSyncStatus",
    "maybeAutoRefreshStandby",
    renderPairing + "\n" + refreshReadiness + "\n" + returnHome
      + "\nreturn { refreshTravelReadiness, returnTravelToHome };",
  );
  return factory(
    els,
    travelAdapter,
    state,
    setConnectivityStep,
    () => {},
    () => {},
    () => {},
    () => false,
    () => "",
    () => ({}),
    () => {},
    () => {},
    () => ({ stale: false }),
    () => "",
    window,
    probeHome,
    api,
    async () => {},
    () => {},
    async () => {},
  );
}

function readinessElements() {
  return {
    travelWorkerUrl: { value: "" },
    travelPairButton: { disabled: true, textContent: "ペアリング済み" },
    pairingHandoffNotice: { hidden: false, textContent: "✓ この画面はLite用クラウドとペアリング済みです。" },
    travelReadiness: { textContent: "" },
    standbyStatus: { textContent: "" },
  };
}

test("再ペアリング要求時は実行経路でペアリングボタンを復帰する", async () => {
  const els = readinessElements();
  const steps = [];
  const adapterError = Object.assign(new Error("expired"), { code: "re_pair_required" });
  const harness = createHarness({
    els,
    state: {},
    travelAdapter: {
      configuredBase: () => "https://worker.test",
      health: async () => ({ ok: true }),
      paired: () => true,
      listStandby: async () => { throw adapterError; },
      currentSession: async () => null,
      errorCode: (error) => error.code || "",
    },
    setConnectivityStep: (...args) => steps.push(args),
    window: {},
    probeHome: async () => false,
    api: async () => {},
  });

  const result = await harness.refreshTravelReadiness();

  assert.equal(result.deviceState, "re_pair_required");
  assert.equal(els.travelPairButton.disabled, false);
  assert.equal(els.travelPairButton.textContent, "ペアリング");
  assert.equal(els.pairingHandoffNotice.hidden, true);
  assert.equal(steps.some(([name, code]) => name === "device" && code === "re_pair_required"), true);
});

test("帰宅前のpending照会失敗は実行経路で帰宅POSTを止める", async () => {
  const apiCalls = [];
  const state = {
    currentTravelSession: { status: "active", travel_session_id: "session-1" },
    travelSession: null,
    returningHome: false,
  };
  const harness = createHarness({
    els: {},
    state,
    travelAdapter: {
      pendingStatus: async () => { throw new Error("worker unreachable"); },
    },
    setConnectivityStep: () => {},
    window: { confirm: () => true },
    probeHome: async () => true,
    api: async (...args) => { apiCalls.push(args); },
  });

  await assert.rejects(
    harness.returnTravelToHome(),
    (error) => /確認できないため、帰宅を停止/.test(error.message),
  );
  assert.equal(apiCalls.length, 0);
  assert.equal(state.returningHome, false);
});


function createSendHarness({ state, travelAdapter, els, appendMessage, removeMessage, loadTravelUsage, crypto }) {
  const sendMessage = extractFunction(
    appSource,
    "async function sendTravelMessage(message)",
    "async function loadAttachmentImage(",
  );
  const factory = new Function(
    "state",
    "travelAdapter",
    "els",
    "appendMessage",
    "removeMessage",
    "loadTravelUsage",
    "crypto",
    "refreshTravelPendingRecovery",
    sendMessage + "\nreturn sendTravelMessage;",
  );
  return factory(state, travelAdapter, els, appendMessage, removeMessage, loadTravelUsage, crypto, async () => {});
}

test("pending拒否時は未送信のユーザー行を画面に残さない", async () => {
  const rows = [];
  const state = {
    travelSession: { travel_session_id: "session-1" },
    travelPersonaId: "persona-1",
  };
  const adapterError = Object.assign(new Error("pending"), { code: "pending_send_unresolved" });
  const sendTravelMessage = createSendHarness({
    state,
    els: { messageInput: { value: "" } },
    travelAdapter: {
      saveDraft: () => {},
      pendingStatus: async () => null,
      send: async () => { throw adapterError; },
      errorCode: (error) => error.code || "",
    },
    appendMessage: (role, text) => {
      const row = { role, text, removed: false };
      rows.push(row);
      return row;
    },
    removeMessage: (row) => { row.removed = true; },
    loadTravelUsage: async () => {},
    crypto: { randomUUID: () => "client-id" },
  });

  await assert.rejects(sendTravelMessage("新しい送信"), /pending/);
  assert.deepEqual(rows.map((row) => ({ role: row.role, removed: row.removed })), [
    { role: "user", removed: true },
    { role: "pending", removed: true },
  ]);
});


for (const code of ["worker_unreachable", "re_pair_required"]) {
  test("前回送信の照会失敗では未送信行を追加しない: " + code, async () => {
    const rows = [];
    let sendCalls = 0;
    let draft = "";
    const sendTravelMessage = createSendHarness({
      state: { travelSession: { travel_session_id: "session-1" }, travelPersonaId: "persona-1" },
      els: { messageInput: { value: "下書き" } },
      travelAdapter: {
        saveDraft: (value) => { draft = value; },
        pendingStatus: async () => { throw Object.assign(new Error(code), { code }); },
        send: async () => { sendCalls += 1; },
        errorCode: (error) => error.code || "",
      },
      appendMessage: (role, text) => { const row = { role, text }; rows.push(row); return row; },
      removeMessage: () => {},
      loadTravelUsage: async () => {},
      crypto: { randomUUID: () => "client-id" },
    });
    await assert.rejects(sendTravelMessage("新しい送信"), (error) => error.code === code);
    assert.deepEqual(rows, []);
    assert.equal(sendCalls, 0);
    assert.equal(draft, "新しい送信");
  });
}
