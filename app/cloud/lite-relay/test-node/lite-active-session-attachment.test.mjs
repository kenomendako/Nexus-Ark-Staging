import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { liteContinuityState } from "../../../mobile_app/static/lite-continuity-state.js";

const source = await readFile(new URL("../../../mobile_app/static/app.js", import.meta.url), "utf8");
function implementation(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function harness(status = "active", mode = "home") {
  const session = { status, travel_session_id: "existing-session" };
  const state = {
    mode, returningHome: false, currentTravelSession: session, travelSession: null,
    connectivity: {
      home: { code: "unreachable" }, worker: { code: "connected" },
      device: { code: "paired" }, standby: { code: status === "returning" ? "returning" : "in_use" },
    },
  };
  const els = Object.fromEntries([
    "standbyRefreshButton", "homeModeButton", "travelModeButton", "returnHomeButton",
    "connectionNextButton", "connectionWizardNextText", "connectionCompactText",
    "connectionCompactIndicator", "connectionCompactButton", "liteModeLabel",
    "locationSelect", "imageInput", "itemButton", "voiceButton", "travelReadiness",
    "standbyStatus", "messageInput", "travelRouteStatus",
  ].map((key) => [key, { textContent: "", value: "", dataset: {} }]));
  const calls = { activate: 0, confirm: 0, history: 0, send: 0 };
  const adapter = {
    paired: () => true,
    currentSession: async () => session,
    activate: async () => { calls.activate++; },
    draft: () => "saved travel draft",
    send: async () => { calls.send++; },
  };
  const factory = new Function("state", "els", "liteContinuityState", "travelAdapter",
    "refreshTravelReadiness", "probeHome", "document", "window", "setExternalAiExportSource",
    "setConnectivityStep", "renderTravelRooms", "refreshTravelPersonaView", "loadTravelHistory",
    "setConnectionStatus", "setSyncStatus", "renderTravelSendFailure",
    ["travelSessionStatus", "applyTravelSessionControls", "renderConnectivityCompact",
      "renderConnectivityNextAction", "setLiteMode", "enterTravelMode"].map(implementation).join("\n")
      + "\nreturn { applyTravelSessionControls, renderConnectivityCompact, renderConnectivityNextAction, enterTravelMode };",
  );
  const ui = factory(state, els, liteContinuityState, adapter,
    async () => ({ health: { ok: true }, deviceState: "paired", snapshots: [] }),
    async () => false, { body: { dataset: {} } },
    { confirm: () => { calls.confirm++; return true; }, location: { origin: "https://lite.test" } },
    () => {}, (key, code) => { state.connectivity[key] = { code }; }, () => {},
    async () => { calls.history++; }, async () => { calls.history++; }, () => {}, () => {}, () => {},
  );
  ui.applyTravelSessionControls();
  ui.renderConnectivityCompact();
  ui.renderConnectivityNextAction();
  return { ...ui, state, els, calls, session };
}

test("PC出発後にペアリングした画面から既存会話を開き、再出発や送信をしない", async () => {
  const ui = harness();
  assert.equal(ui.els.travelModeButton.disabled, false);
  assert.equal(ui.els.standbyRefreshButton.disabled, true);
  assert.equal(ui.els.connectionNextButton.dataset.action, "travel");
  assert.equal(ui.els.connectionNextButton.hidden, false);
  assert.doesNotMatch(ui.els.connectionCompactText.textContent, /準備が必要/);
  await ui.enterTravelMode();
  assert.equal(ui.state.mode, "travel");
  assert.equal(ui.state.travelSession, ui.session);
  assert.equal(ui.els.messageInput.value, "saved travel draft");
  assert.equal(ui.calls.history, 1);
  assert.deepEqual([ui.calls.activate, ui.calls.confirm, ui.calls.send], [0, 0, 0]);
  assert.equal(ui.els.travelModeButton.disabled, true);
});

test("会話を開いた後は現在のモードと帰宅案内を再表示する", async () => {
  const ui = harness();
  await ui.enterTravelMode();
  assert.equal(ui.els.connectionNextButton.dataset.action, "home_return");
  assert.doesNotMatch(ui.els.connectionCompactText.textContent, /開いてください|準備が必要/);
  assert.match(ui.els.liteModeLabel.textContent, /独立モード/);
});

test("帰宅途中は独立会話・データ更新を止め、帰宅再開だけを案内する", async () => {
  const ui = harness("returning");
  assert.equal(ui.els.travelModeButton.disabled, true);
  assert.equal(ui.els.standbyRefreshButton.disabled, true);
  assert.equal(ui.els.connectionNextButton.dataset.action, "home_return");
  assert.match(ui.els.connectionNextButton.textContent, /帰宅を再開/);
  assert.doesNotMatch(ui.els.connectionCompactText.textContent, /準備が必要/);
  await assert.rejects(ui.enterTravelMode(), /帰宅処理中/);
  assert.equal(ui.state.mode, "home");
  assert.equal(ui.state.travelSession, null);
  assert.deepEqual([ui.calls.activate, ui.calls.history, ui.calls.send], [0, 0, 0]);
});

test("帰宅操作中は既存会話を開く操作も止める", () => {
  const ui = harness();
  ui.state.returningHome = true;
  ui.applyTravelSessionControls();
  assert.equal(ui.els.travelModeButton.disabled, true);
});
