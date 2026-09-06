import { travelAdapter } from "./travel-adapter.js?v=86";
import { parsePairingHandoff } from "./pairing-handoff.js?v=86";
import { liteContinuityState, readableApiError } from "./lite-continuity-state.js?v=86";

const LITE_UI_BUILD = "v86";

function isCloudHostedLite() {
  return true;
}

function homeDefaultBase() {
  return isCloudHostedLite() ? "" : window.location.origin;
}

function initialHomeBase() {
  const saved = readConnectionValue("nexusLite.apiBase");
  if (isCloudHostedLite() && saved.replace(/\/$/, "") === window.location.origin) return "";
  return saved || homeDefaultBase();
}

function readConnectionValue(key) {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const value = storage.getItem(key);
      if (value) return value;
    } catch {
      // 片方の保存領域が利用できない場合も、もう片方を試す。
    }
  }
  return "";
}

function writeConnectionValue(key, value) {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(key, value);
    } catch {
      // PWA実装によって片方だけ利用できない場合があるため、接続自体は継続する。
    }
  }
}

const state = {
  apiBase: initialHomeBase(),
  token: readConnectionValue("nexusLite.token"),
  rooms: [],
  roomId: localStorage.getItem("nexusLite.roomId") || "",
  connected: false,
  sending: false,
  syncing: false,
  statusRefreshing: false,
  recording: false,
  transcribing: false,
  speaking: false,
  stopRequested: false,
  notificationPermission: "unsupported",
  ttsMode: localStorage.getItem("nexusLite.ttsMode") || "trim",
  managementLoaded: false,
  twitterDrafts: [],
  currentAudio: null,
  stopCurrentPlayback: null,
  mediaRecorder: null,
  recordingStream: null,
  audioChunks: [],
  recordingStartedAt: 0,
  recordingTimer: null,
  recordingTimeout: null,
  pushSubscriptionCount: 0,
  responsePreviewEnabled: true,
  theme: localStorage.getItem("nexusLite.theme") || "green",
  colorScheme: localStorage.getItem("nexusLite.colorScheme") || "auto",
  redactionEnabled: false,
  redactionRules: [],
  chatMessages: [],
  historyLimit: 12,
  activePage: "chat",
  items: [],
  preparedChatAttachments: [],
  currentNote: null,
  noteEditing: false,
  pendingSend: readPendingSend(),
  mode: "home",
  travelSession: null,
  currentTravelSession: null,
  returningHome: false,
  travelPersonaId: "",
  travelProfiles: [],
  travelModels: [],
  travelModelLoadId: 0,
  travelRouteChanging: false,
  travelRouteUsable: true,
  travelBudgetStopped: false,
  homeReachable: false,
  externalAiExportSource: null,
  latestStandbySnapshot: null,
  standbyAutoRefreshing: false,
  deferredInstallPrompt: null,
  connectivity: {
    home: { code: "checking" },
    worker: { code: "checking" },
    device: { code: "checking" },
    standby: { code: "checking" },
  },
};

const VOICE_RECORDING_MAX_MS = 60000;
const RECENT_SUBMIT_GUARD_MS = 3000;
const PENDING_RESEND_GRACE_MS = 3000;
const STATUS_REFRESH_INTERVAL_MS = 15000;
const STANDBY_FRESHNESS_WARNING_MS = 6 * 60 * 60 * 1000;
const STANDBY_AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const els = {
  liteModeLabel: document.querySelector("#lite-mode-label"),
  standbyShortcutButton: document.querySelector("#standby-shortcut-button"),
  snapshotFreshness: document.querySelector("#snapshot-freshness"),
  travelReadiness: document.querySelector("#travel-readiness"),
  homeModeButton: document.querySelector("#home-mode-button"),
  travelModeButton: document.querySelector("#travel-mode-button"),
  returnHomeButton: document.querySelector("#return-home-button"),
  travelWorkerUrl: document.querySelector("#travel-worker-url"),
  travelDeviceName: document.querySelector("#travel-device-name"),
  travelPairingCode: document.querySelector("#travel-pairing-code"),
  pairingHandoffNotice: document.querySelector("#pairing-handoff-notice"),
  travelPairButton: document.querySelector("#travel-pair-button"),
  standbyRefreshButton: document.querySelector("#standby-refresh-button"),
  standbyDataPreset: document.querySelector("#standby-data-preset"),
  standbyDataPresetStatus: document.querySelector("#standby-data-preset-status"),
  standbyDataCustomDetails: document.querySelector("#standby-data-custom-details"),
  standbyIncludeCoreMemoryCheckbox: document.querySelector("#standby-include-core-memory-checkbox"),
  standbyIncludeEpisodicMemoryCheckbox: document.querySelector("#standby-include-episodic-memory-checkbox"),
  standbyEpisodicMemoryDays: document.querySelector("#standby-episodic-memory-days"),
  standbyRecentMessageLimit: document.querySelector("#standby-recent-message-limit"),
  standbyAutoRefreshCheckbox: document.querySelector("#standby-auto-refresh-checkbox"),
  standbyStatus: document.querySelector("#standby-status"),
  installCard: document.querySelector("#install-card"),
  installStatus: document.querySelector("#install-status"),
  installAppButton: document.querySelector("#install-app-button"),
  browserPairingConfirmation: document.querySelector("#browser-pairing-confirmation"),
  browserPairingConfirmationCheckbox: document.querySelector("#browser-pairing-confirmation-checkbox"),
  externalAiExportDetails: document.querySelector("#external-ai-export-details"),
  externalAiPersonaSelect: document.querySelector("#external-ai-persona-select"),
  externalAiDisclosureCheckbox: document.querySelector("#external-ai-disclosure-checkbox"),
  externalAiShowButton: document.querySelector("#external-ai-show-button"),
  externalAiExportStatus: document.querySelector("#external-ai-export-status"),
  externalAiExportResult: document.querySelector("#external-ai-export-result"),
  externalAiExportText: document.querySelector("#external-ai-export-text"),
  externalAiCopyButton: document.querySelector("#external-ai-copy-button"),
  externalAiClearButton: document.querySelector("#external-ai-clear-button"),
  storageContext: document.querySelector("#storage-context"),
  connectionCompactButton: document.querySelector("#connection-compact-button"),
  connectionCompactIndicator: document.querySelector("#connection-compact-indicator"),
  connectionCompactText: document.querySelector("#connection-compact-text"),
  connectionCheckButton: document.querySelector("#connection-check-button"),
  connectionNextButton: document.querySelector("#connection-next-button"),
  connectionWizardNextText: document.querySelector("#connection-wizard-next-text"),
  homeConnectionStep: document.querySelector("#home-connection-step"),
  homeConnectionState: document.querySelector("#home-connection-state"),
  homeConnectionNext: document.querySelector("#home-connection-next"),
  workerConnectionStep: document.querySelector("#worker-connection-step"),
  workerConnectionState: document.querySelector("#worker-connection-state"),
  workerConnectionNext: document.querySelector("#worker-connection-next"),
  deviceConnectionStep: document.querySelector("#device-connection-step"),
  deviceConnectionState: document.querySelector("#device-connection-state"),
  deviceConnectionNext: document.querySelector("#device-connection-next"),
  standbyConnectionStep: document.querySelector("#standby-connection-step"),
  standbyConnectionState: document.querySelector("#standby-connection-state"),
  standbyConnectionNext: document.querySelector("#standby-connection-next"),
  apiBaseInput: document.querySelector("#api-base-input"),
  tokenInput: document.querySelector("#token-input"),
  connectButton: document.querySelector("#connect-button"),
  connectionDetails: document.querySelector("#connection-details"),
  connectionSummaryUrl: document.querySelector("#connection-summary-url"),
  refreshButton: document.querySelector("#refresh-button"),
  loadMoreButton: document.querySelector("#load-more-button"),
  connectionStatus: document.querySelector("#connection-status"),
  roomTitle: document.querySelector("#room-title"),
  roomSelect: document.querySelector("#room-select"),
  syncStatus: document.querySelector("#sync-status"),
  syncButton: document.querySelector("#sync-button"),
  ttsModeSelect: document.querySelector("#tts-mode-select"),
  stopAudioButton: document.querySelector("#stop-audio-button"),
  secureOriginNotice: document.querySelector("#secure-origin-notice"),
  managementDetails: document.querySelector("#management-details"),
  managementSummaryStatus: document.querySelector("#management-summary-status"),
  letterboxSection: document.querySelector("#letterbox-section"),
  letterboxSummaryStatus: document.querySelector("#letterbox-summary-status"),
  letterboxList: document.querySelector("#letterbox-list"),
  letterboxRefreshButton: document.querySelector("#letterbox-refresh-button"),
  letterboxReader: document.querySelector("#letterbox-reader"),
  letterboxReaderTitle: document.querySelector("#letterbox-reader-title"),
  letterboxReaderMeta: document.querySelector("#letterbox-reader-meta"),
  letterboxReaderBody: document.querySelector("#letterbox-reader-body"),
  draftRefreshButton: document.querySelector("#draft-refresh-button"),
  draftSelect: document.querySelector("#draft-select"),
  draftContent: document.querySelector("#draft-content"),
  draftMeta: document.querySelector("#draft-meta"),
  draftMediaGrid: document.querySelector("#draft-media-grid"),
  draftApproveButton: document.querySelector("#draft-approve-button"),
  draftRejectButton: document.querySelector("#draft-reject-button"),
  locationSelect: document.querySelector("#location-select"),
  autonomyMeta: document.querySelector("#autonomy-meta"),
  autonomyQuietButton: document.querySelector("#autonomy-quiet-button"),
  autonomyNormalButton: document.querySelector("#autonomy-normal-button"),
  noteMeta: document.querySelector("#note-meta"),
  noteTypeSelect: document.querySelector("#note-type-select"),
  noteRefreshButton: document.querySelector("#note-refresh-button"),
  noteHeadingSelect: document.querySelector("#note-heading-select"),
  noteShowSectionButton: document.querySelector("#note-show-section-button"),
  noteViewer: document.querySelector("#note-viewer"),
  noteEditor: document.querySelector("#note-editor"),
  noteEditButton: document.querySelector("#note-edit-button"),
  noteSaveButton: document.querySelector("#note-save-button"),
  noteCancelButton: document.querySelector("#note-cancel-button"),
  notificationMeta: document.querySelector("#notification-meta"),
  notificationEnableButton: document.querySelector("#notification-enable-button"),
  notificationTestButton: document.querySelector("#notification-test-button"),
  notificationUnsubscribeCurrentButton: document.querySelector("#notification-unsubscribe-current-button"),
  notificationDetail: document.querySelector("#notification-detail"),
  eventNotificationEnabled: document.querySelector("#event-notification-enabled"),
  responsePreviewEnabled: document.querySelector("#response-preview-enabled"),
  eventNotificationMinimum: document.querySelector("#event-notification-minimum"),
  eventNotificationCooldown: document.querySelector("#event-notification-cooldown"),
  eventNotificationSourceCooldowns: document.querySelector("#event-notification-source-cooldowns"),
  eventNotificationSaveButton: document.querySelector("#event-notification-save-button"),
  pushDeviceList: document.querySelector("#push-device-list"),
  expressionValue: document.querySelector("#expression-value"),
  arousalValue: document.querySelector("#arousal-value"),
  locationValue: document.querySelector("#location-value"),
  driveBoredom: document.querySelector("#drive-boredom"),
  driveCuriosity: document.querySelector("#drive-curiosity"),
  driveGoal: document.querySelector("#drive-goal"),
  driveRelated: document.querySelector("#drive-related"),
  messages: document.querySelector("#messages"),
  newMessageButton: document.querySelector("#new-message-button"),
  chatForm: document.querySelector("#chat-form"),
  messageInput: document.querySelector("#message-input"),
  imageInput: document.querySelector("#image-input"),
  itemButton: document.querySelector("#item-button"),
  voiceButton: document.querySelector("#voice-button"),
  attachmentName: document.querySelector("#attachment-name"),
  imageDialog: document.querySelector("#image-dialog"),
  imageDialogImg: document.querySelector("#image-dialog-img"),
  itemDialog: document.querySelector("#item-dialog"),
  closeItemDialog: document.querySelector("#close-item-dialog"),
  itemTargetSelect: document.querySelector("#item-target-select"),
  itemSelect: document.querySelector("#item-select"),
  itemPreview: document.querySelector("#item-preview"),
  itemActionSelect: document.querySelector("#item-action-select"),
  itemAmountInput: document.querySelector("#item-amount-input"),
  itemFurnitureField: document.querySelector("#item-furniture-field"),
  itemFurnitureInput: document.querySelector("#item-furniture-input"),
  itemDetail: document.querySelector("#item-detail"),
  itemRefreshButton: document.querySelector("#item-refresh-button"),
  itemExecuteButton: document.querySelector("#item-execute-button"),
  menuDetails: document.querySelector("#menu-details"),
  pageTitle: document.querySelector("#page-title"),
  closeImageDialog: document.querySelector("#close-image-dialog"),
  sendButton: document.querySelector("#send-button"),
  travelRoutePanel: document.querySelector("#travel-route-panel"),
  travelCurrentRoute: document.querySelector("#travel-current-route"),
  travelProfileSelect: document.querySelector("#travel-profile-select"),
  travelModelSelect: document.querySelector("#travel-model-select"),
  travelModelRefreshButton: document.querySelector("#travel-model-refresh-button"),
  travelModelStatus: document.querySelector("#travel-model-status"),
  travelRouteApplyButton: document.querySelector("#travel-route-apply-button"),
  travelRouteStatus: document.querySelector("#travel-route-status"),
  travelUsageKnown: document.querySelector("#travel-usage-known"),
  travelUsageBudget: document.querySelector("#travel-usage-budget"),
  travelUsageWarning: document.querySelector("#travel-usage-warning"),
  personaAvatar: document.querySelector("#persona-avatar"),
  themeDetails: document.querySelector("#theme-details"),
  themeSummaryStatus: document.querySelector("#theme-summary-status"),
  themeSelect: document.querySelector("#theme-select"),
  colorSchemeSelect: document.querySelector("#color-scheme-select"),
  redactionDetails: document.querySelector("#redaction-details"),
  redactionSummaryStatus: document.querySelector("#redaction-summary-status"),
  redactionEnabledCheckbox: document.querySelector("#redaction-enabled-checkbox"),
  ruleFindInput: document.querySelector("#rule-find-input"),
  ruleReplaceInput: document.querySelector("#rule-replace-input"),
  ruleColorInput: document.querySelector("#rule-color-input"),
  addRuleButton: document.querySelector("#add-rule-button"),
  rulesList: document.querySelector("#rules-list")
};

function readPendingSend() {
  try {
    return JSON.parse(localStorage.getItem("nexusLite.pendingSend") || "null");
  } catch {
    return null;
  }
}

function writePendingSend(value) {
  state.pendingSend = value;
  if (value) {
    localStorage.setItem("nexusLite.pendingSend", JSON.stringify(value));
  } else {
    localStorage.removeItem("nexusLite.pendingSend");
  }
}

function draftStorageKey(roomId = state.roomId) {
  return `nexusLite.draft.${roomId || "default"}`;
}

function saveComposerDraft() {
  const value = els.messageInput.value;
  if (value) {
    localStorage.setItem(draftStorageKey(), value);
  } else {
    localStorage.removeItem(draftStorageKey());
  }
}

function restoreComposerDraft() {
  if (state.pendingSend?.roomId === state.roomId && state.pendingSend.message) {
    els.messageInput.value = state.pendingSend.message;
    state.preparedChatAttachments = state.pendingSend.attachments || [];
  } else {
    els.messageInput.value = localStorage.getItem(draftStorageKey()) || "";
    state.preparedChatAttachments = [];
  }
  els.messageInput.dispatchEvent(new Event("input"));
}

function setActivePage(page) {
  const normalized = ["chat", "records", "management", "settings"].includes(page) ? page : "chat";
  state.activePage = normalized;
  document.body.dataset.activePage = normalized;
  const labels = { records: "記録", management: "管理", settings: "設定" };
  if (els.pageTitle) {
    els.pageTitle.textContent = labels[normalized] || "";
  }
  for (const button of document.querySelectorAll("[data-nav-page]")) {
    const active = button.dataset.navPage === normalized;
    button.classList.toggle("active", active);
    button.toggleAttribute("aria-current", active);
  }
  if (normalized !== "chat") {
    els.menuDetails.open = true;
    els.managementDetails.open = true;
    refreshManagement().catch((error) => setSyncStatus(`管理情報の取得に失敗しました: ${error.message}`, "warn"));
    if (normalized === "records") {
      refreshLetterbox();
    }
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function updatePendingSendPatch(patch) {
  if (!state.pendingSend) {
    return null;
  }
  const updated = {
    ...state.pendingSend,
    ...patch
  };
  writePendingSend(updated);
  return updated;
}

function pendingAgeMs(pending) {
  const timestamp = Date.parse(pending?.sentAt || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function selectedFileSignature(file) {
  if (!file) {
    return null;
  }
  return {
    name: file.name || "",
    size: Number(file.size || 0)
  };
}

function canReleaseUnconfirmedPending(pending) {
  if (!pending || pending.roomId !== state.roomId) {
    return false;
  }
  if (pending.confirmation !== "not_found") {
    return false;
  }
  if (pendingAgeMs(pending) < PENDING_RESEND_GRACE_MS) {
    return false;
  }
  return true;
}

function markPendingResponseNotificationWanted() {
  const pending = state.pendingSend;
  if (!pending || pending.notifyOnResponse) {
    return;
  }
  writePendingSend({
    ...pending,
    notifyOnResponse: true
  });
}

async function notifyResponseIfWanted(message) {
  const pending = state.pendingSend;
  if (!pending?.notifyOnResponse) {
    return false;
  }
  if (state.pushSubscriptionCount > 0) {
    return false;
  }
  return showLiteNotification("Nexus Ark Lite", message || responseNotificationText());
}

function currentRoomDisplayName() {
  const room = state.rooms.find((item) => item.room_id === state.roomId);
  return room?.display_name || state.roomId || "Nexus Ark Lite";
}

function responseNotificationText() {
  return `${currentRoomDisplayName()}からのメッセージがあります。`;
}

function responseNotificationBody(reply) {
  const speaker = currentRoomDisplayName();
  if (!state.responsePreviewEnabled) {
    return responseNotificationText();
  }
  const excerpt = String(reply || "").replace(/\s+/g, " ").trim();
  if (!excerpt) {
    return responseNotificationText();
  }
  const limit = 42;
  const clipped = excerpt.length > limit ? `${excerpt.slice(0, limit).trim()}...` : excerpt;
  return `${speaker}「${clipped}」`;
}

function clearSelectedImage() {
  els.imageInput.value = "";
  els.attachmentName.textContent = "";
}

function normalizeBase(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function setConnectionStatus(text, mode = "idle") {
  els.connectionStatus.textContent = text;
  els.connectionStatus.dataset.mode = mode;
}

function setSyncStatus(text, mode = "idle") {
  els.syncStatus.textContent = text || "";
  els.syncStatus.dataset.mode = mode;
}

function setConnectivityStep(key, code, mode, label, next) {
  state.connectivity[key] = { code, mode, label, next };
  const prefix = `${key}Connection`;
  els[`${prefix}Step`].dataset.mode = mode;
  els[`${prefix}State`].textContent = label;
  els[`${prefix}Next`].textContent = next;
  renderConnectivityNextAction();
  renderConnectivityCompact();
}

function renderConnectivityCompact() {
  if (!els.connectionCompactText) return;
  const { home, worker, device, standby } = state.connectivity;
  const checking = [home, worker, device, standby].some((item) => item.code === "checking");
  let text = "接続状態を確認しています";
  let icon = "◌";
  let mode = "checking";

  if (!checking && device.code === "re_pair_required") {
    text = "スマホの再接続が必要です";
    icon = "!";
    mode = "error";
  } else if (!checking && worker.code !== "connected") {
    text = "Lite用クラウドの設定を確認してください";
    icon = "!";
    mode = "warn";
  } else if (!checking && device.code !== "paired") {
    text = "このスマホを接続してください";
    icon = "!";
    mode = "warn";
  } else if (!checking && standby.code !== "ready") {
    text = "お出かけ前のデータ準備が必要です";
    icon = "!";
    mode = "warn";
  } else if (!checking && home.code === "connected") {
    text = "接続準備済み";
    icon = "✓";
    mode = "ok";
  } else if (!checking && worker.code === "connected" && device.code === "paired" && standby.code === "ready") {
    text = "独立モードの準備ができています";
    icon = "✓";
    mode = "ok";
  } else if (!checking) {
    text = "本体へ接続できません";
    icon = "!";
    mode = "error";
  }

  els.connectionCompactText.textContent = text;
  els.connectionCompactIndicator.textContent = icon;
  els.connectionCompactButton.dataset.mode = mode;
}

function renderStorageContext() {
  const standalone = isInstalledDisplayMode();
  els.storageContext.textContent = standalone
    ? `現在: インストール済みPWA（UI ${LITE_UI_BUILD} / 接続元 ${window.location.origin}）。通常ブラウザと認証が共有されない場合があります。`
    : `現在: 通常ブラウザ（UI ${LITE_UI_BUILD} / 接続元 ${window.location.origin}）。インストール済みPWAとは認証が共有されない場合があります。`;
}

function renderTravelPairingState(paired, justCompleted = false) {
  els.travelPairButton.textContent = paired ? "ペアリング済み" : "ペアリング";
  els.travelPairButton.disabled = paired;
  if (paired) {
    els.pairingHandoffNotice.hidden = false;
    els.pairingHandoffNotice.textContent = justCompleted
      ? "✓ この画面のペアリングが完了しました。状態カードの「端末」もペアリング済みです。"
      : "✓ この画面はLite用クラウドとペアリング済みです。";
  } else if (els.pairingHandoffNotice.textContent.startsWith("✓")) {
    els.pairingHandoffNotice.hidden = true;
    els.pairingHandoffNotice.textContent = "";
  }
}

function isInstalledDisplayMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function snapshotAgeLabel(createdAt, now = Date.now()) {
  const timestamp = Date.parse(createdAt || "");
  if (!Number.isFinite(timestamp)) return { text: "お出かけ前データ 保存時刻不明", stale: true };
  const ageMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(ageMs / 60_000);
  let elapsed;
  if (minutes < 1) elapsed = "たった今";
  else if (minutes < 60) elapsed = `${minutes}分前`;
  else if (minutes < 48 * 60) elapsed = `${Math.floor(minutes / 60)}時間前`;
  else elapsed = `${Math.floor(minutes / (24 * 60))}日前`;
  const saved = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
  return {
    text: `お出かけ前データ 保存済み・${saved}（${elapsed}）${ageMs >= STANDBY_FRESHNESS_WARNING_MS ? "・更新おすすめ" : ""}`,
    stale: ageMs >= STANDBY_FRESHNESS_WARNING_MS,
  };
}

function travelSessionStatus() {
  return String(state.currentTravelSession?.status || state.travelSession?.status || "");
}

function travelSessionBlocksStandby() {
  return liteContinuityState(travelSessionStatus(), state.mode, state.returningHome).blocksStandby;
}

function applyTravelSessionControls() {
  const view = liteContinuityState(travelSessionStatus(), state.mode, state.returningHome);
  els.standbyRefreshButton.disabled = view.blocksStandby || state.returningHome;
  els.standbyRefreshButton.title = view.blocksStandby
    ? view.status === "returning"
      ? "帰宅処理を完了してから、お出かけ前データを更新できます。"
      : "独立モードの使用中です。署名付き帰宅後に更新できます。"
    : "現在の状態をお出かけ前データとして保存します。";
  els.homeModeButton.textContent = view.homeLabel;
  els.homeModeButton.disabled = view.homeDisabled;
  els.travelModeButton.disabled = view.travelDisabled;
  els.returnHomeButton.hidden = true;
}

function rememberLatestStandby(snapshot) {
  if (!snapshot?.created_at) return;
  state.latestStandbySnapshot = {
    created_at: snapshot.created_at,
    generation: snapshot.generation,
  };
  localStorage.setItem("nexusLite.latestStandbySnapshot", JSON.stringify(state.latestStandbySnapshot));
  renderSnapshotFreshness();
}

function forgetLatestStandby() {
  state.latestStandbySnapshot = null;
  localStorage.removeItem("nexusLite.latestStandbySnapshot");
  renderSnapshotFreshness();
}

function renderSnapshotFreshness() {
  if (!els.snapshotFreshness) return;
  const view = liteContinuityState(travelSessionStatus(), state.mode, state.returningHome);
  if (view.blocksStandby) {
    els.snapshotFreshness.textContent = view.freshnessText;
    els.snapshotFreshness.dataset.mode = "warn";
    els.snapshotFreshness.title = view.status === "returning"
      ? "署名付き帰宅を再開してください。"
      : "独立モードで使用中のため、新しいデータは帰宅後に保存できます。";
    return;
  }
  const snapshot = state.latestStandbySnapshot;
  if (!snapshot) {
    els.snapshotFreshness.textContent = "お出かけ前データ 未保存";
    els.snapshotFreshness.dataset.mode = "warn";
    els.snapshotFreshness.title = "本体接続中に、お出かけ前のデータを準備してください。";
    return;
  }
  const age = snapshotAgeLabel(snapshot.created_at);
  els.snapshotFreshness.textContent = age.text;
  els.snapshotFreshness.dataset.mode = age.stale ? "warn" : "ok";
  els.snapshotFreshness.title = `世代${snapshot.generation} / ${snapshot.created_at}`;
}

function openStandbySettings() {
  setActivePage("settings");
  els.connectionDetails.open = true;
  els.standbyStatus.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => els.standbyStatus.focus(), 250);
}

function installFallbackText() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isiOS) return "Safariの共有ボタンから「ホーム画面に追加」を選んでください。追加したLiteを開いてからペアリングします。";
  return "ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選んでください。追加したLiteを開いてからペアリングします。";
}

function renderInstallState() {
  const installed = isInstalledDisplayMode();
  els.browserPairingConfirmation.hidden = installed;
  if (installed) {
    els.installStatus.textContent = "インストール済みPWAです。この画面でペアリングすると持ち出し時にも設定を使えます。";
    els.installAppButton.hidden = true;
    els.browserPairingConfirmationCheckbox.checked = true;
    return;
  }
  els.installAppButton.hidden = false;
  els.installAppButton.textContent = state.deferredInstallPrompt ? "この端末へインストール" : "インストール方法を表示";
  els.installStatus.textContent = "現在は通常ブラウザです。持ち出す場合は、先にインストールして開き直すのがおすすめです。";
}

async function installLiteApp() {
  if (!state.deferredInstallPrompt) {
    window.alert(installFallbackText());
    return;
  }
  const prompt = state.deferredInstallPrompt;
  state.deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") {
    els.installStatus.textContent = "インストールを開始しました。ホーム画面のLiteを開いてからペアリングしてください。";
    els.installAppButton.hidden = true;
  } else {
    renderInstallState();
    els.installStatus.textContent = "インストールは行いませんでした。通常ブラウザへペアリングする場合は保存先確認が必要です。";
  }
}

function workerFailureDiagnostic(health) {
  let workerOrigin = "未設定";
  try {
    workerOrigin = new URL(travelAdapter.configuredBase()).origin;
  } catch {
    // 不正URLは「未設定」のまま表示し、元文字列を再表示しない。
  }
  const primary = [health.browser_error, health.browser_message].filter(Boolean).join(": ") || "記録なし";
  const fallback = [health.fallback_error, health.fallback_message].filter(Boolean).join(": ") || "記録なし";
  const response = health.http_status
    ? `HTTP ${health.http_status} / ${health.content_type || "type不明"} / schema ${health.api_schema_version ?? "不明"}`
    : "HTTP応答なし";
  return `UI ${LITE_UI_BUILD} / PWA ${window.location.origin} / Worker ${workerOrigin} / online ${navigator.onLine} / secure ${window.isSecureContext} / ${response} / fetch ${primary} / no-cors ${fallback}`;
}

function renderConnectivityNextAction() {
  if (!els.connectionNextButton) return;
  const { home, worker, device, standby } = state.connectivity;
  let text = "接続状態を確認しています。";
  let label = "";
  let action = "";

  if (home.code === "checking" || worker.code === "checking" || device.code === "checking" || standby.code === "checking") {
    text = "4つの接続状態を確認しています。";
  } else if (worker.code !== "connected") {
    if (worker.code === "pwa_update_required") {
      text = "Lite用クラウドは更新済みです。このPWAを最新版へ更新してください。再ペアリングは不要です。";
      label = "PWAを更新して再読み込み";
      action = "pwa_update";
    } else if (worker.code === "cors_rejected") {
      text = `このPWAの接続元 ${window.location.origin} がLite用クラウドで許可されていません。本体側の許可URLと一致させてください。`;
      label = "Lite用クラウド設定を開く";
      action = "worker";
    } else {
      text = worker.code === "worker_update_required"
        ? "Nexus Ark本体からLite用クラウドを更新してください。"
        : "次にLite用クラウドを設定し、接続を確認してください。";
      label = "Lite用クラウド設定を開く";
      action = "worker";
    }
  } else if (device.code !== "paired") {
    text = device.code === "re_pair_required"
      ? "この画面の端末認証は無効です。新しい短期コードで再ペアリングしてください。"
      : "実際に持ち出すこの画面で端末をペアリングしてください。";
    label = device.code === "re_pair_required" ? "再ペアリングする" : "ペアリングする";
    action = "pair";
  } else if (["in_use", "returning"].includes(standby.code)) {
    text = standby.code === "returning"
      ? "署名付き帰宅が途中です。完了すると、お出かけ前のデータを更新できます。"
      : "独立モードで使用中です。署名付き帰宅後に、お出かけ前のデータを更新できます。";
    label = standby.code === "returning" ? "帰宅を再開" : "署名付き帰宅";
    action = "home_return";
  } else if (standby.code !== "ready") {
    text = "最後に、本体接続中の状態をお出かけ前のデータとして準備してください。";
    label = "お出かけ前のデータを準備";
    action = "standby";
  } else if (home.code !== "connected") {
    text = "本体へ接続できませんが、独立モードの準備はできています。自動では開始しません。";
    label = "独立モードを確認して開始";
    action = "travel";
  } else {
    text = "準備完了です。本体停止時も、独立モードは確認操作後にだけ開始します。";
  }

  els.connectionWizardNextText.textContent = text;
  els.connectionNextButton.hidden = !action;
  els.connectionNextButton.textContent = label;
  els.connectionNextButton.dataset.action = action;
}

function openConnectionSettings(focusTarget) {
  setActivePage("settings");
  els.connectionDetails.open = true;
  els.connectionDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => focusTarget?.focus(), 250);
}

function runConnectivityNextAction() {
  const action = els.connectionNextButton.dataset.action;
  if (action === "travel") {
    els.travelModeButton.click();
  } else if (action === "home") {
    openConnectionSettings(els.apiBaseInput);
  } else if (action === "worker") {
    openConnectionSettings(els.travelWorkerUrl);
  } else if (action === "pwa_update") {
    updatePwaShell().catch((error) => setSyncStatus(`PWAを更新できませんでした: ${error.message}`, "warn"));
  } else if (action === "pair") {
    openConnectionSettings(els.travelPairingCode);
  } else if (action === "standby") {
    els.standbyRefreshButton.click();
  } else if (action === "home_return") {
    els.homeModeButton.click();
  }
}

async function updatePwaShell() {
  setSyncStatus("PWAの最新版を確認しています…");
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.update()));
  }
  const target = new URL(window.location.href);
  target.searchParams.set("lite_update", String(Date.now()));
  window.location.replace(target.href);
}

function formatConnectionError(error) {
  const message = String(error?.message || error || "");
  if (message.startsWith("401 ")) {
    return "Tokenを入力して接続してください。";
  }
  if (message.startsWith("403 ")) {
    return "Tokenが未設定または一致していません。";
  }
  return message || "接続できませんでした。";
}

function showConnectionError(error) {
  const message = formatConnectionError(error);
  state.connected = false;
  els.roomTitle.textContent = "接続できません";
  setConnectionStatus("接続エラー", "error");
  setSyncStatus(message, "warn");
  setConnectivityStep("home", "connection_error", "error", "接続エラー", "API URLと接続用Tokenを確認してください。");
  els.connectionDetails.open = true;
}

function setNotificationDetail(text, mode = "idle") {
  if (!els.notificationDetail) {
    return;
  }
  els.notificationDetail.textContent = text || "";
  els.notificationDetail.dataset.mode = mode;
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label}が${ms / 1000}秒以内に完了しませんでした。`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isSecureVoiceOrigin() {
  return window.location.protocol === "https:" || isLocalHost(window.location.hostname);
}

function isNotificationSupported() {
  return "Notification" in window;
}

function isWebPushSupported() {
  return isNotificationSupported() && "serviceWorker" in navigator && "PushManager" in window;
}

function updateNotificationStatus() {
  if (!isNotificationSupported()) {
    state.notificationPermission = "unsupported";
    els.notificationMeta.textContent = "未対応";
    els.notificationEnableButton.disabled = true;
    els.notificationTestButton.disabled = true;
    return;
  }
  state.notificationPermission = Notification.permission;
  if (!isSecureVoiceOrigin()) {
    els.notificationMeta.textContent = "HTTPSが必要";
    els.notificationEnableButton.disabled = true;
    els.notificationTestButton.disabled = true;
    return;
  }
  const labels = {
    granted: "許可済み",
    denied: "拒否済み",
    default: "未許可"
  };
  const pushText = isWebPushSupported() ? " / Push対応" : " / Push未対応";
  els.notificationMeta.textContent = `${labels[state.notificationPermission] || state.notificationPermission}${pushText}`;
  els.notificationEnableButton.disabled = state.notificationPermission === "granted" || state.notificationPermission === "denied";
  els.notificationTestButton.disabled = state.notificationPermission !== "granted";
}

function applyThemeSettings() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.colorScheme = state.colorScheme;

  if (els.themeSelect) {
    els.themeSelect.value = state.theme;
  }
  if (els.colorSchemeSelect) {
    els.colorSchemeSelect.value = state.colorScheme;
  }

  if (els.themeSummaryStatus) {
    const themeNameMap = {
      green: "グリーン",
      blue: "ブルー",
      red: "レッド",
      purple: "パープル",
      orange: "オレンジ",
      yellow: "イエロー"
    };
    const modeNameMap = {
      auto: "自動",
      light: "ライト",
      dark: "ダーク"
    };
    const tName = themeNameMap[state.theme] || state.theme;
    const mName = modeNameMap[state.colorScheme] || state.colorScheme;
    els.themeSummaryStatus.textContent = `${tName} / ${mName}`;
  }
}

function applyRedactionSettings() {
  state.redactionEnabled = localStorage.getItem("nexusLite.redactionEnabled") === "true";
  try {
    state.redactionRules = JSON.parse(localStorage.getItem("nexusLite.redactionRules")) || [
      { find: "ユーザー", replace: "ゲスト", color: "#62827e" }
    ];
  } catch {
    state.redactionRules = [
      { find: "ユーザー", replace: "ゲスト", color: "#62827e" }
    ];
  }

  if (els.redactionEnabledCheckbox) {
    els.redactionEnabledCheckbox.checked = state.redactionEnabled;
  }
  if (els.redactionSummaryStatus) {
    els.redactionSummaryStatus.textContent = state.redactionEnabled ? "有効" : "オフ";
    els.redactionSummaryStatus.className = state.redactionEnabled ? "status-pill ok" : "status-pill";
  }
  renderRulesList();
}

function renderRulesList() {
  if (!els.rulesList) return;
  els.rulesList.innerHTML = "";
  if (state.redactionRules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-item";
    empty.style.justifyContent = "center";
    empty.style.color = "var(--muted)";
    empty.textContent = "ルールがありません";
    els.rulesList.appendChild(empty);
    return;
  }

  state.redactionRules.forEach((rule, idx) => {
    const li = document.createElement("li");
    li.className = "rule-item";

    const content = document.createElement("div");
    content.className = "rule-item-content";

    const findText = document.createElement("span");
    findText.textContent = `${rule.find} ➔ `;
    content.appendChild(findText);

    const replaceBadge = document.createElement("span");
    replaceBadge.className = "rule-badge";
    replaceBadge.textContent = rule.replace || "(空)";
    if (rule.color) {
      replaceBadge.style.backgroundColor = rule.color;
    } else {
      replaceBadge.style.backgroundColor = "var(--muted)";
    }
    content.appendChild(replaceBadge);

    li.appendChild(content);

    const delBtn = document.createElement("button");
    delBtn.className = "delete-rule-btn";
    delBtn.type = "button";
    delBtn.innerHTML = "✖";
    delBtn.title = "削除";
    delBtn.addEventListener("click", () => {
      state.redactionRules.splice(idx, 1);
      localStorage.setItem("nexusLite.redactionRules", JSON.stringify(state.redactionRules));
      renderRulesList();
      renderChatMessages();
    });
    li.appendChild(delBtn);

    els.rulesList.appendChild(li);
  });
}

function applyRedactions(text) {
  let result = escapeHtml(text || "");
  if (!state.redactionEnabled || !state.redactionRules || state.redactionRules.length === 0) {
    return result;
  }
  for (const rule of state.redactionRules) {
    const findStr = rule.find;
    if (!findStr) continue;
    const replaceStr = rule.replace || "";
    const color = rule.color;

    const escapedFind = escapeHtml(findStr);
    const escapedReplace = escapeHtml(replaceStr);

    const escapedRegex = escapedFind.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedRegex, 'g');

    if (color) {
      const replacementHtml = `<span style="background-color: ${color}; color: #ffffff; padding: 2px 4px; border-radius: 3px; font-weight: bold;">${escapedReplace}</span>`;
      result = result.replace(regex, replacementHtml);
    } else {
      result = result.replace(regex, escapedReplace);
    }
  }
  return result;
}

function escapeHtml(string) {
  if (typeof string !== 'string') {
    return string;
  }
  return string.replace(/[&<>"']/g, function (match) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return map[match];
  });
}

async function requestNotificationPermission() {
  if (!isNotificationSupported() || !isSecureVoiceOrigin()) {
    updateNotificationStatus();
    setSyncStatus("通知にはHTTPSまたはlocalhostが必要です。", "warn");
    return false;
  }
  try {
    const permission = await Notification.requestPermission();
    state.notificationPermission = permission;
    updateNotificationStatus();
    if (permission !== "granted") {
      setSyncStatus("通知が許可されませんでした。", "warn");
      return false;
    }
    if (state.connected && state.roomId) {
      await subscribeWebPush().catch((error) => setSyncStatus(`Push購読を保存できませんでした: ${error.message}`, "warn"));
    }
    setSyncStatus("通知を許可しました。");
    return true;
  } catch (error) {
    setSyncStatus(`通知許可を取得できませんでした: ${error.message}`, "warn");
    updateNotificationStatus();
    return false;
  }
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  if (registration.active) {
    return registration;
  }
  const worker = registration.installing || registration.waiting;
  if (!worker) {
    return registration;
  }
  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error("Service Workerの有効化が完了しませんでした。")), 5000);
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") {
        window.clearTimeout(timeoutId);
        resolve();
      }
    });
  });
  return registration;
}

async function focusLiteWindow() {
  try {
    window.focus();
  } catch {
    // focus may be blocked by the browser, but assigning location still helps fallback notifications.
  }
  if (window.location.pathname !== "/") {
    window.location.href = "/";
  }
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return outputArray;
}

function arrayBufferEquals(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) {
    return false;
  }
  const leftView = new Uint8Array(left);
  const rightView = new Uint8Array(right);
  for (let index = 0; index < leftView.length; index += 1) {
    if (leftView[index] !== rightView[index]) {
      return false;
    }
  }
  return true;
}

async function subscribeWebPush({ updateDetail = true } = {}) {
  if (!isWebPushSupported() || Notification.permission !== "granted" || !state.connected || !state.roomId) {
    return null;
  }
  const showStep = (text) => {
    if (updateDetail) {
      setNotificationDetail(text);
    }
  };
  showStep("Push購読: VAPID公開鍵取得中...");
  const keyResponse = await api("/api/v1/push/vapid-public-key", { timeoutMs: 8000 });
  const applicationServerKey = urlBase64ToUint8Array(keyResponse.public_key);

  showStep("Push購読: Service Worker準備中...");
  const registration = await withTimeout(ensureServiceWorkerRegistration(), 8000, "Service Worker準備");
  if (!registration?.pushManager) {
    throw new Error("PushManagerを利用できません。PWAとしてインストール済みか確認してください。");
  }

  showStep("Push購読: 既存購読確認中...");
  let subscription = await withTimeout(registration.pushManager.getSubscription(), 5000, "既存Push購読確認");
  if (subscription?.options?.applicationServerKey && !arrayBufferEquals(subscription.options.applicationServerKey, applicationServerKey)) {
    showStep("Push購読: 古い購読を解除中...");
    await withTimeout(subscription.unsubscribe(), 5000, "古いPush購読解除");
    subscription = null;
  }
  if (!subscription) {
    showStep("Push購読: ブラウザ購読作成中...");
    subscription = await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      }),
      10000,
      "ブラウザPush購読作成"
    );
  }
  showStep("Push購読: API Gatewayへ保存中...");
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/push/subscriptions`, {
    method: "POST",
    body: JSON.stringify({
      ...subscription.toJSON(),
      user_agent: navigator.userAgent || ""
    }),
    timeoutMs: 8000
  });
  state.pushSubscriptionCount = Number(response.subscription_count || 0);
  els.notificationMeta.textContent = `Push保存済み ${response.subscription_count}`;
  if (updateDetail) {
    const cleanupText = response.detail ? ` / ${response.detail}` : "";
    setNotificationDetail(`Push保存: subscriptions=${response.subscription_count}${cleanupText}`);
  }
  return response;
}

function describePushDevices(response) {
  const subscriptions = Array.isArray(response?.subscriptions) ? response.subscriptions : [];
  const deviceText = subscriptions
    .slice(0, 3)
    .map((item, index) => {
      const label = item.endpoint_host || `Push端末 ${index + 1}`;
      const failures = Number(item.failure_count || 0);
      return failures > 0 ? `${label}(失敗${failures})` : label;
    })
    .join(", ");
  const cleanupText = response?.cleaned_count ? ` / 古い購読掃除 ${response.cleaned_count}` : "";
  return `Push保存: subscriptions=${response?.subscription_count || 0}${deviceText ? ` / ${deviceText}` : ""}${cleanupText}`;
}

function formatPushDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderPushDevices(response) {
  if (!els.pushDeviceList) {
    return;
  }
  els.pushDeviceList.replaceChildren();
  const subscriptions = Array.isArray(response?.subscriptions) ? response.subscriptions : [];
  if (!subscriptions.length) {
    const empty = document.createElement("div");
    empty.className = "push-device-empty";
    empty.textContent = "保存済みPush端末はありません。";
    els.pushDeviceList.appendChild(empty);
    return;
  }
  subscriptions.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "push-device-row";

    const text = document.createElement("div");
    text.className = "push-device-text";
    const title = document.createElement("strong");
    title.textContent = item.endpoint_host || `Push端末 ${index + 1}`;
    const meta = document.createElement("span");
    const failureText = Number(item.failure_count || 0) > 0 ? ` / 失敗 ${item.failure_count}` : "";
    meta.textContent = `更新 ${formatPushDate(item.updated_at)} / 成功 ${formatPushDate(item.last_success_at)}${failureText}`;
    text.append(title, meta);

    const button = document.createElement("button");
    button.className = "secondary-button compact-button";
    button.type = "button";
    button.textContent = "削除";
    button.addEventListener("click", () => deletePushSubscription(item.id));

    row.append(text, button);
    els.pushDeviceList.appendChild(row);
  });
}

async function refreshPushStatus({ updateDetail = true } = {}) {
  if (!state.connected || !state.roomId || Notification.permission !== "granted") {
    updateNotificationStatus();
    renderPushDevices({ subscriptions: [] });
    return null;
  }
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/push/status`);
  state.pushSubscriptionCount = Number(response.subscription_count || 0);
  els.notificationMeta.textContent = `許可済み / Push保存 ${response.subscription_count}`;
  renderPushDevices(response);
  if (updateDetail) {
    setNotificationDetail(describePushDevices(response));
  }
  return response;
}

async function deletePushSubscription(subscriptionId) {
  if (!state.connected || !state.roomId || !subscriptionId) {
    return;
  }
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    timeoutMs: 8000
  });
  state.pushSubscriptionCount = Number(response.subscription_count || 0);
  setNotificationDetail(`Push端末削除: status=${response.status} subscriptions=${response.subscription_count}`);
  await refreshPushStatus({ updateDetail: false });
}

async function unsubscribeCurrentPushDevice() {
  if (!isWebPushSupported()) {
    setNotificationDetail("このブラウザではPush解除を利用できません。", "warn");
    return;
  }
  try {
    const registration = await withTimeout(ensureServiceWorkerRegistration(), 8000, "Service Worker準備");
    const subscription = await withTimeout(registration?.pushManager?.getSubscription(), 5000, "既存Push購読確認");
    if (!subscription) {
      setNotificationDetail("この端末のPush購読はありません。");
      await refreshPushStatus({ updateDetail: false });
      return;
    }
    const endpoint = subscription.endpoint || "";
    const subscriptionId = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))
      .then((buffer) => Array.from(new Uint8Array(buffer)).slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    await withTimeout(subscription.unsubscribe(), 5000, "ブラウザPush購読解除");
    await deletePushSubscription(subscriptionId);
    setNotificationDetail("この端末のPush購読を解除しました。");
  } catch (error) {
    setNotificationDetail(`Push解除に失敗しました: ${error.message}`, "warn");
  }
}

async function showLiteNotification(title, body) {
  if (!isNotificationSupported() || Notification.permission !== "granted") {
    return false;
  }
  const options = {
    body: String(body || ""),
    icon: "/icon.png",
    badge: "/badge.png",
    tag: "nexus-ark-lite",
    data: { url: `${window.location.origin}/` }
  };
  try {
    const registration = await ensureServiceWorkerRegistration();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
    } else {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        notification.close();
        focusLiteWindow();
      };
    }
    return true;
  } catch (error) {
    setSyncStatus(`通知を表示できませんでした: ${error.message}`, "warn");
    return false;
  }
}

async function testLiteNotification() {
  if (!state.connected || !state.roomId) {
    setSyncStatus("Push通知テストにはAPI接続が必要です。", "warn");
    setNotificationDetail("Push通知テストにはAPI接続が必要です。", "warn");
    return;
  }
  if (Notification.permission !== "granted") {
    const granted = await requestNotificationPermission();
    if (!granted) {
      return;
    }
  }
  try {
    setNotificationDetail("Web Pushテスト送信中...");
    await subscribeWebPush({ updateDetail: true });
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/push/test`, {
      method: "POST",
      body: JSON.stringify({ title: "Nexus Ark Lite", body: "Web Pushテストです。" }),
      timeoutMs: 15000
    });
    const message = response.status === "sent" || response.status === "partial"
      ? `Web Pushテスト送信: subscriptions=${response.subscription_count} sent=${response.sent} failed=${response.failed}`
      : `Web Pushテスト未送信: subscriptions=${response.subscription_count || 0} status=${response.status} detail=${response.detail || "-"}`;
    if (response.status === "sent" || response.status === "partial") {
      setSyncStatus(message);
      setNotificationDetail(message);
    } else {
      setSyncStatus(message, "warn");
      setNotificationDetail(message, "warn");
    }
  } catch (error) {
    setSyncStatus(`Web Pushテストに失敗しました: ${error.message}`, "warn");
    setNotificationDetail(`Web Pushテストに失敗しました: ${error.message}`, "warn");
  }
  await refreshPushStatus({ updateDetail: false }).catch(() => updateNotificationStatus());
}

function renderSecureOriginNotice() {
  if (isSecureVoiceOrigin()) {
    els.secureOriginNotice.hidden = true;
    els.secureOriginNotice.textContent = "";
    return;
  }
  let hostHint = "";
  try {
    const url = new URL(state.apiBase || window.location.origin);
    if (url.hostname.endsWith(".ts.net")) {
      hostHint = `https://${url.host}/lite`;
    } else if (url.hostname.startsWith("100.")) {
      hostHint = "https://<PCのTailscale DNS名>.ts.net/lite";
    }
  } catch {
    hostHint = "";
  }
  els.secureOriginNotice.hidden = false;
  els.secureOriginNotice.textContent = hostHint
    ? `録音にはHTTPSが必要です。音声入力は ${hostHint} で開くと使えます。`
    : "録音にはHTTPSまたはlocalhostが必要です。Tailscale HTTPS URLで開くと音声入力が使えます。";
}

function updateConnectionSummary() {
  if (!state.apiBase) {
    els.connectionSummaryUrl.textContent = "本体接続（未設定）";
    return;
  }
  try {
    const url = new URL(state.apiBase);
    els.connectionSummaryUrl.textContent = url.host || state.apiBase || "接続設定";
  } catch {
    els.connectionSummaryUrl.textContent = state.apiBase || "接続設定";
  }
}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (state.token) {
    h.Authorization = `Bearer ${state.token}`;
  }
  return h;
}

function authHeaders() {
  const h = {};
  if (state.token) {
    h.Authorization = `Bearer ${state.token}`;
  }
  return h;
}

async function api(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = timeoutMs
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const response = await fetch(`${state.apiBase}${path}`, {
    ...fetchOptions,
    signal: controller?.signal || fetchOptions.signal,
    headers: {
      ...headers(),
      ...(fetchOptions.headers || {})
    }
  }).catch((error) => {
    if (error.name === "AbortError") {
      throw new Error(`${path} が${timeoutMs / 1000}秒以内に応答しませんでした。`);
    }
    throw error;
  }).finally(() => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(readableApiError(
      response.status,
      response.statusText,
      response.headers.get("content-type"),
      body,
    ));
  }
  return response.json();
}

function setLiteMode(mode) {
  state.mode = mode === "travel" ? "travel" : "home";
  document.body.dataset.liteMode = state.mode;
  els.liteModeLabel.textContent = state.mode === "travel" ? "🧳 独立モード" : "🏠 本体接続";
  applyTravelSessionControls();
  els.locationSelect.disabled = state.mode === "travel";
  els.imageInput.disabled = state.mode === "travel";
  els.itemButton.disabled = state.mode === "travel";
  els.voiceButton.disabled = state.mode === "travel";
}

function travelPersonas() {
  const session = state.travelSession;
  if (!session) return [];
  return Array.isArray(session.personas) ? session.personas : [{
    persona_id: session.persona_id,
    persona_display_name: session.persona_display_name || session.persona_id,
    credential_profile_id: session.credential_profile_id,
    provider: session.provider,
    model_id: session.model_id,
    route_epoch: session.route_epoch,
    route_changed_at: session.route_changed_at,
  }];
}

const TRAVEL_PROVIDER_LABELS = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  openrouter: "OpenRouter",
};

function currentTravelPersona() {
  return travelPersonas().find((item) => item.persona_id === state.travelPersonaId) || null;
}

function renderTravelCurrentRoute() {
  const route = currentTravelPersona();
  if (!route) {
    els.travelCurrentRoute.textContent = "使用するAIが未設定です";
    return;
  }
  const provider = TRAVEL_PROVIDER_LABELS[route.provider] || route.provider || "不明";
  els.travelCurrentRoute.textContent = `${provider} / ${route.model_id || "不明"}`;
}

function selectedTravelModel() {
  return state.travelModels.find((item) => item.model_id === els.travelModelSelect.value) || null;
}

function setTravelRouteControls() {
  const busy = state.sending || state.travelRouteChanging;
  els.roomSelect.disabled = busy;
  els.travelProfileSelect.disabled = busy || state.travelProfiles.length === 0;
  els.travelModelSelect.disabled = busy || state.travelModels.length === 0;
  els.travelModelRefreshButton.disabled = busy || !els.travelProfileSelect.value;
  els.travelRouteApplyButton.disabled = busy || !selectedTravelModel()?.available;
  if (state.mode === "travel") {
    els.sendButton.disabled =
      busy || !state.travelRouteUsable || state.travelBudgetStopped;
  }
}

function travelModelReason(model) {
  if (model.unavailable_reason === "not_text_chat_capable") return "テキスト会話非対応";
  if (model.unavailable_reason === "capability_unverified") return "対応未確認";
  return "";
}

async function loadTravelModels(profileId, refresh = false) {
  const loadId = ++state.travelModelLoadId;
  state.travelModels = [];
  els.travelModelSelect.replaceChildren();
  els.travelModelStatus.textContent = "モデル一覧を確認しています。";
  setTravelRouteControls();
  let body;
  try {
    body = await travelAdapter.models(profileId, refresh);
  } catch (error) {
    if (loadId !== state.travelModelLoadId) return;
    els.travelModelStatus.textContent =
      "モデル一覧を取得できません。現在使用中のAIは変更していません。";
    setTravelRouteControls();
    throw error;
  }
  if (loadId !== state.travelModelLoadId || profileId !== els.travelProfileSelect.value) return;
  state.travelModels = Array.isArray(body.models) ? body.models : [];
  for (const model of state.travelModels) {
    const option = document.createElement("option");
    const reason = travelModelReason(model);
    const price = model.pricing_known ? "料金確認済み" : "料金不明";
    option.value = model.model_id;
    option.disabled = !model.available;
    option.textContent =
      `${model.display_name || model.model_id}${model.display_name && model.display_name !== model.model_id ? ` — ${model.model_id}` : ""}` +
      `${reason ? `（${reason}）` : `（${price}）`}`;
    els.travelModelSelect.append(option);
  }
  const persona = currentTravelPersona();
  const currentProfile = persona?.credential_profile_id === profileId;
  const current = currentProfile
    ? state.travelModels.find((item) => item.model_id === persona.model_id)
    : null;
  const firstAvailable = state.travelModels.find((item) => item.available);
  if (current?.available) els.travelModelSelect.value = current.model_id;
  else if (firstAvailable) els.travelModelSelect.value = firstAvailable.model_id;
  if (currentProfile) {
    state.travelRouteUsable = Boolean(current?.available);
  }
  const source = body.source === "live"
    ? "最新一覧"
    : body.source === "stale"
      ? "保存済み一覧（一時的に更新できません）"
      : "最近確認した一覧";
  const routeWarning = currentProfile && !current?.available
    ? " 現在のモデルを利用できるか確認できないため送信を停止しました。利用できるAIとモデルを選んでください。"
    : "";
  els.travelModelStatus.textContent =
    `${state.travelModels.length}件（${source}）。利用不能・能力未確認モデルは選択できません。${routeWarning}`;
  setTravelRouteControls();
}

async function loadTravelUsage() {
  if (!state.travelSession || !state.travelPersonaId) return;
  const summary = await travelAdapter.usageSummary(state.travelSession, state.travelPersonaId);
  const known = Number(summary.known_cost_usd || 0);
  const pending = Number(summary.pending_reserved_usd || 0);
  const limit = summary.persona_budget
    ? summary.persona_budget.session_limit_usd
    : summary.budget?.session_limit_usd;
  const stopped = summary.stopped === true;
  state.travelBudgetStopped = stopped;
  els.travelUsageKnown.textContent =
    `利用額: 約$${known.toFixed(4)}${summary.unknown_price_count ? `・金額不明 ${summary.unknown_price_count}件` : ""}`;
  els.travelUsageBudget.textContent =
    limit == null
      ? `応答用に一時確保: 約$${pending.toFixed(4)} / 上限なし`
      : `応答用に一時確保: 約$${pending.toFixed(4)} / 上限 $${Number(limit).toFixed(4)}`;
  els.travelUsageWarning.textContent = stopped
    ? "予算上限に到達しています。送信を停止します。"
    : summary.warning
      ? "予算上限に近づいています。"
      : "";
  setTravelRouteControls();
}

async function loadTravelRouteControls() {
  renderTravelCurrentRoute();
  els.travelRouteStatus.textContent = "";
  const body = await travelAdapter.providerProfiles();
  state.travelProfiles = Array.isArray(body.profiles) ? body.profiles : [];
  els.travelProfileSelect.replaceChildren();
  for (const profile of state.travelProfiles) {
    const option = document.createElement("option");
    option.value = profile.credential_profile_id;
    option.disabled = !profile.enabled;
    option.textContent =
      `${profile.display_name}（${TRAVEL_PROVIDER_LABELS[profile.provider] || profile.provider}）` +
      `${profile.enabled ? "" : " — 利用停止中"}`;
    els.travelProfileSelect.append(option);
  }
  const currentProfileId = currentTravelPersona()?.credential_profile_id || "";
  els.travelProfileSelect.value = currentProfileId;
  const currentProfile = state.travelProfiles.find(
    (item) => item.credential_profile_id === currentProfileId,
  );
  if (currentProfile?.enabled) {
    await loadTravelModels(els.travelProfileSelect.value);
  } else {
    els.travelModelStatus.textContent = currentProfile
      ? "現在のAI接続は利用停止中です。利用できるAIサービスとモデルを選んでください。"
      : "現在のAI接続を確認できません。利用できるAIサービスとモデルを選んでください。";
    state.travelRouteUsable = false;
    setTravelRouteControls();
  }
}

async function refreshTravelPersonaView() {
  state.travelBudgetStopped = false;
  state.travelRouteUsable = true;
  await Promise.all([
    loadTravelRouteControls(),
    loadTravelUsage(),
    loadTravelHistory(),
  ]);
}

async function applyTravelRouteChange() {
  if (!state.travelSession || state.sending || state.travelRouteChanging) return;
  const profile = state.travelProfiles.find(
    (item) => item.credential_profile_id === els.travelProfileSelect.value,
  );
  const model = selectedTravelModel();
  if (!profile?.enabled || !model?.available) return;
  const persona = currentTravelPersona();
  if (
    profile.credential_profile_id === persona?.credential_profile_id &&
    model.model_id === persona?.model_id
  ) {
    els.travelRouteStatus.textContent = "すでに現在使用中のAIです。";
    return;
  }
  const next = `${TRAVEL_PROVIDER_LABELS[profile.provider] || profile.provider} / ${model.model_id}`;
  const priceWarning = model.pricing_known
    ? ""
    : " このモデルの料金はまだ概算表示に対応していません。利用額には金額不明として記録されます。";
  if (!window.confirm(
    `今回使うAIを ${next} へ変更します。これまでの会話内容は引き継がれます。送信中の内容を自動で送り直すことはありません。${priceWarning} よろしいですか？`,
  )) return;
  state.travelRouteChanging = true;
  els.travelRouteStatus.textContent = "使用するAIを変更しています。";
  setTravelRouteControls();
  try {
    const result = await travelAdapter.changeRoute(
      state.travelSession,
      state.travelPersonaId,
      profile.credential_profile_id,
      model.model_id,
    );
    const routeTarget = Array.isArray(state.travelSession.personas)
      ? persona
      : state.travelSession;
    Object.assign(routeTarget, result.route || {});
    state.travelRouteUsable = true;
    renderTravelCurrentRoute();
    els.travelRouteStatus.textContent = result.changed
      ? `${next} へ切り替えました。`
      : "使用するAIは変更されませんでした。";
    await Promise.all([loadTravelHistory(), loadTravelUsage()]);
  } catch (error) {
    els.travelRouteStatus.textContent = error.message === "session_message_in_progress"
      ? "送信中のため切り替えられません。応答確定後に再試行してください。"
      : "使用するAIを変更できませんでした。現在のAIを維持します。";
  } finally {
    state.travelRouteChanging = false;
    setTravelRouteControls();
  }
}

function renderTravelRooms() {
  const personas = travelPersonas();
  els.roomSelect.replaceChildren();
  for (const persona of personas) {
    const option = document.createElement("option");
    option.value = persona.persona_id;
    option.textContent = persona.persona_display_name || persona.display_name || persona.persona_id;
    els.roomSelect.append(option);
  }
  state.travelPersonaId = personas.some((item) => item.persona_id === state.travelPersonaId)
    ? state.travelPersonaId
    : personas[0]?.persona_id || "";
  els.roomSelect.value = state.travelPersonaId;
}

async function loadTravelHistory() {
  if (!state.travelSession || !state.travelPersonaId) return [];
  const body = await travelAdapter.events(state.travelSession, state.travelPersonaId);
  const persona = currentTravelPersona();
  const inherited = Array.isArray(persona?.inherited_recent_messages)
    ? persona.inherited_recent_messages.filter((message) => message?.content).map((message) => ({
      role: message.role === "assistant" ? "agent" : "user",
      content: message.content,
      timestamp: persona.snapshot_created_at || "",
      inherited: true,
    }))
    : [];
  const inheritedHeading = inherited.length ? [{
    role: "system",
    content: "お出かけ前から引き継いだ直近の会話",
    inherited: true,
  }] : [];
  const travelEvents = (body.events || []).filter((event) => event.content).map((event) => ({
    role: event.type === "user_message" ? "user" : event.type === "assistant_message" ? "agent" : "system",
    content: event.type === "route_changed" ? travelRouteMarker(event) : event.content,
    timestamp: event.created_at,
    model: event.model_resolved || event.model_requested || "",
  }));
  state.chatMessages = [...inheritedHeading, ...inherited, ...travelEvents];
  renderChatMessages();
  return state.chatMessages;
}

function travelRouteMarker(event) {
  let provider = event.provider || "不明";
  let model = event.model_resolved || event.model_requested || "不明";
  try {
    const detail = JSON.parse(event.content || "{}");
    provider = detail.provider || provider;
    model = detail.model_id || model;
  } catch {
    // 旧イベントでも安全な列値から表示する。
  }
  return `今回使うAIを ${TRAVEL_PROVIDER_LABELS[provider] || provider} / ${model} へ変更しました。`;
}

async function refreshTravelReadiness() {
  els.travelWorkerUrl.value = travelAdapter.configuredBase();
  const health = await travelAdapter.health().catch((error) => ({
    ok: false,
    error: "worker_unreachable",
    browser_error: String(error?.name || "Error").slice(0, 40),
    browser_message: String(error?.message || "").replace(/[\r\n]+/g, " ").slice(0, 160),
  }));
  if (!health.ok) {
    const missing = health.error === "worker_url_missing";
    const pwaUpdate = health.error === "pwa_update_required";
    const workerUpdate = health.error === "worker_update_required";
    const corsRejected = health.error === "cors_rejected";
    els.travelReadiness.textContent = missing
      ? "Lite用クラウド未設定"
      : pwaUpdate
        ? "PWAの更新が必要"
        : workerUpdate
          ? "Lite用クラウド更新が必要"
          : corsRejected
            ? "PWAの接続元が未許可"
          : "Lite用クラウドへ接続できません";
    setConnectivityStep(
      "worker",
      missing ? "missing" : pwaUpdate ? "pwa_update_required" : workerUpdate ? "worker_update_required" : corsRejected ? "cors_rejected" : "unreachable",
      missing ? "warn" : "error",
      missing ? "未設定" : pwaUpdate ? "PWA更新が必要" : workerUpdate ? "クラウド更新が必要" : corsRejected ? "接続元が未許可" : "接続不可",
      missing
        ? "Lite用クラウドのURLを設定してください。"
        : pwaUpdate
          ? "PWAを更新して再読み込みしてください。再ペアリングは不要です。"
          : workerUpdate
            ? "本体側でLite用クラウドを更新してください。"
            : corsRejected
              ? `現在のPWA: ${window.location.origin}。本体側の許可URLと一致させてください。`
            : `共有用診断: ${workerFailureDiagnostic(health)}`,
    );
    setConnectivityStep(
      "device",
      travelAdapter.paired() ? "unchecked" : "unpaired",
      "warn",
      travelAdapter.paired() ? "未確認" : "未ペアリング",
      "Lite用クラウド接続後に端末認証を確認します。",
    );
    setConnectivityStep("standby", "blocked", "warn", "確認できません", "Lite用クラウド接続後にお出かけ前のデータを確認します。");
    return { health, snapshots: [], deviceState: travelAdapter.paired() ? "unchecked" : "unpaired" };
  }
  setConnectivityStep("worker", "connected", "ok", "接続済み", "次に端末認証を確認します。");
  if (!travelAdapter.paired()) {
    renderTravelPairingState(false);
    els.travelReadiness.textContent = "Lite用クラウド接続済み・端末未ペアリング";
    setConnectivityStep("device", "unpaired", "warn", "未ペアリング", "この画面で短期ペアリングコードを入力してください。");
    setConnectivityStep("standby", "blocked", "warn", "確認できません", "ペアリング後にお出かけ前のデータを確認します。");
    return { health, snapshots: [], deviceState: "unpaired" };
  }
  renderTravelPairingState(true);
  let standby;
  let currentSession;
  try {
    [standby, currentSession] = await Promise.all([
      travelAdapter.listStandby(),
      travelAdapter.currentSession(),
    ]);
  } catch (error) {
    const code = travelAdapter.errorCode(error);
    if (code === "re_pair_required") {
      els.travelReadiness.textContent = "再ペアリングが必要";
      els.standbyStatus.textContent = "お出かけ前のデータ: 端末認証を確認できません（再ペアリングが必要）";
      setConnectivityStep("device", "re_pair_required", "error", "再ペアリングが必要", "本体で新しい短期コードを発行し、この画面で入力してください。");
      setConnectivityStep("standby", "auth_blocked", "warn", "認証待ち", "再ペアリング後にお出かけ前のデータを確認します。");
      return { health, snapshots: [], deviceState: "re_pair_required" };
    }
    const workerUnavailable = code === "worker_unreachable";
    els.travelReadiness.textContent = workerUnavailable ? "Lite用クラウドへ接続できません" : "端末認証を確認できません";
    setConnectivityStep(
      "device",
      code || "auth_check_failed",
      "warn",
      "確認できません",
      workerUnavailable ? "Lite用クラウドへの通信を確認して再試行してください。" : "Lite用クラウドの状態を確認して再試行してください。",
    );
    setConnectivityStep("standby", "blocked", "warn", "確認できません", "端末認証の確認後に再試行します。");
    return { health, snapshots: [], deviceState: code || "auth_check_failed" };
  }
  setConnectivityStep("device", "paired", "ok", "ペアリング済み", "次にお出かけ前のデータを確認します。");
  const ready = (standby.snapshots || []).filter((item) => item.status === "ready");
  state.currentTravelSession = currentSession || null;
  applyTravelSessionControls();
  renderSnapshotFreshness();
  if (!currentSession && !state.travelSession) {
    setExternalAiExportSource(ready[0] ? { kind: "standby", value: ready[0] } : null);
  }
  if (ready[0]) rememberLatestStandby(ready[0]);
  if (travelSessionBlocksStandby()) {
    const view = liteContinuityState(travelSessionStatus(), state.mode, state.returningHome);
    els.travelReadiness.textContent = view.readinessText;
    els.standbyStatus.textContent = view.standbyStatusText;
    setConnectivityStep(
      "standby",
      view.standbyCode,
      "warn",
      view.standbyLabel,
      view.standbyNext,
    );
    renderSnapshotFreshness();
    return { health, snapshots: ready, deviceState: "paired", currentSession };
  }
  els.travelReadiness.textContent = ready.length ? `お出かけ前データ ${ready.length}件` : "お出かけ前データなし";
  if (ready[0]) {
    const freshness = snapshotAgeLabel(ready[0].created_at);
    const stale = freshness.stale ? "・更新推奨" : "";
    els.standbyStatus.textContent = `お出かけ前のデータ: 世代${ready[0].generation} / ${ready[0].created_at}${stale}`;
    setConnectivityStep(
      "standby",
      "ready",
      stale ? "warn" : "ok",
      `準備済み（世代${ready[0].generation}）${stale}`,
      stale ? "本体接続中に更新すると現在の状態へ近づきます。" : "必要時に独立モードを明示開始できます。",
    );
  } else {
    forgetLatestStandby();
    els.standbyStatus.textContent = "お出かけ前のデータ: 未準備";
    setConnectivityStep("standby", "missing", "warn", "未準備", "本体接続中にお出かけ前のデータを準備してください。");
  }
  return { health, snapshots: ready, deviceState: "paired", currentSession };
}

function setExternalAiExportSource(source) {
  state.externalAiExportSource = source;
  const personas = source?.kind === "session"
    ? (source.value.personas || [{
      persona_id: source.value.persona_id,
      persona_display_name: source.value.persona_display_name,
    }])
    : (source?.value?.personas || []);
  els.externalAiPersonaSelect.replaceChildren();
  for (const persona of personas) {
    const option = document.createElement("option");
    option.value = persona.persona_id;
    option.textContent = persona.persona_display_name || persona.display_name || persona.persona_id;
    els.externalAiPersonaSelect.append(option);
  }
  els.externalAiShowButton.disabled = !personas.length;
  els.externalAiExportStatus.textContent = personas.length
    ? source.kind === "session"
      ? "独立モード開始時点の内容から文面を作れます。"
      : `待機データ 世代${source.value.generation}（${source.value.created_at}）から文面を作れます。`
    : "利用できる準備済みデータがありません。本体接続中に先に準備してください。";
}

function clearExternalAiExport() {
  els.externalAiExportText.value = "";
  els.externalAiExportResult.hidden = true;
  els.externalAiDisclosureCheckbox.checked = false;
}

async function showExternalAiExport() {
  if (!els.externalAiDisclosureCheckbox.checked) {
    throw new Error("外部AIとクリップボードへ渡る内容を確認し、チェックを入れてください。");
  }
  const source = state.externalAiExportSource;
  const personaId = els.externalAiPersonaSelect.value;
  if (!source || !personaId) throw new Error("利用できるペルソナデータがありません。");
  const result = source.kind === "session"
    ? await travelAdapter.externalAiExportFromSession(source.value.travel_session_id, personaId)
    : await travelAdapter.externalAiExportFromStandby(source.value.standby_snapshot_id, personaId);
  els.externalAiExportText.value = result.text || "";
  els.externalAiExportResult.hidden = false;
  els.externalAiExportStatus.textContent = `${result.persona_display_name} / ${result.content_chars}文字。内容を確認してからコピーしてください。`;
}

async function copyExternalAiExport() {
  const text = els.externalAiExportText.value;
  if (!text) throw new Error("先に外部AI用の文面を表示してください。");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    els.externalAiExportText.focus();
    els.externalAiExportText.select();
    if (!document.execCommand("copy")) {
      throw new Error("自動コピーできませんでした。文面を長押ししてコピーしてください。");
    }
  }
  els.externalAiExportStatus.textContent = "コピーしました。外部AIの最初のメッセージ欄へ貼り付けてください。";
}

async function probeHome() {
  if (!state.apiBase) {
    setConnectivityStep("home", "missing", "warn", "未設定", "Nexus Ark本体のAPI URLを設定してください。");
    return false;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`${state.apiBase}/health`, { cache: "no-store", signal: controller.signal });
    state.homeReachable = response.ok;
  } catch {
    state.homeReachable = false;
  } finally {
    window.clearTimeout(timeout);
  }
  if (state.homeReachable && state.connected) {
    setConnectivityStep("home", "connected", "ok", "接続済み", "次にLite用クラウドの状態を確認します。");
  } else if (state.homeReachable) {
    setConnectivityStep("home", "reachable", "warn", "到達可能・未接続", "接続用Tokenで本体へ接続してください。");
  } else {
    setConnectivityStep("home", "unreachable", "error", "接続不可", "本体の起動、API URL、ネットワークを確認してください。");
  }
  return state.homeReachable;
}

async function enterTravelMode() {
  const [readiness] = await Promise.all([refreshTravelReadiness(), probeHome()]);
  if (!readiness.health.ok) throw new Error("Lite用クラウドへ接続できません。");
  if (readiness.deviceState === "re_pair_required") throw new Error("端末認証が失効しています。新しい短期コードで再ペアリングしてください。");
  if (!travelAdapter.paired()) throw new Error("先に独立モード端末をペアリングしてください。");
  let session = await travelAdapter.currentSession();
  if (!session) {
    const standby = readiness.snapshots[0];
    if (!standby) throw new Error("利用できるお出かけ前のデータがありません。");
    const mode = state.homeReachable ? "planned" : "recovery_unconfirmed";
    const warning = mode === "planned"
      ? "本体へ接続できています。独立モードを開始しますか？"
      : "本体状態を確認できません。home側と分岐する可能性を記録して独立モードを開始しますか？";
    if (!window.confirm(warning)) return;
    await travelAdapter.activate(standby.standby_snapshot_id, mode);
    session = await travelAdapter.currentSession();
  }
  if (!session) throw new Error("独立モードsessionを取得できません。");
  state.travelSession = session;
  state.currentTravelSession = session;
  setExternalAiExportSource({ kind: "session", value: session });
  setLiteMode("travel");
  const activeView = liteContinuityState(travelSessionStatus(), state.mode, state.returningHome);
  els.travelReadiness.textContent = activeView.readinessText;
  els.standbyStatus.textContent = activeView.standbyStatusText;
  setConnectivityStep("standby", activeView.standbyCode, "warn", activeView.standbyLabel, activeView.standbyNext);
  renderTravelRooms();
  els.messageInput.value = travelAdapter.draft();
  try {
    await refreshTravelPersonaView();
  } catch (error) {
    els.travelRouteStatus.textContent =
      "経路または利用額を確認できません。現在の経路は変更していません。";
    await loadTravelHistory();
    setSyncStatus(`独立モードの経路確認に失敗しました: ${error.message}`, "warn");
  }
  setConnectionStatus("Lite用クラウド接続中", "ok");
  if (!els.travelRouteStatus.textContent) {
    setSyncStatus("独立モードです。本体へ自動切替しません。");
  }
}

async function enterHomeMode() {
  if (!state.homeReachable) throw new Error("本体へまだ接続できません。");
  if (state.travelSession) throw new Error("独立モードを署名付き帰宅してから本体へ戻ってください。");
  setLiteMode("home");
  renderRooms();
  restoreComposerDraft();
  await loadPrimaryRoomData();
  setConnectionStatus("接続済み", "ok");
}

async function pairTravelDevice() {
  travelAdapter.configure(els.travelWorkerUrl.value.trim());
  if (travelAdapter.paired()) {
    throw new Error("このPWAには端末情報が保存済みです。先に「状態を再確認」または「PWAを更新して再読み込み」を行ってください。");
  }
  if (!isInstalledDisplayMode() && !els.browserPairingConfirmationCheckbox.checked) {
    throw new Error("通常ブラウザとPWAは設定が分かれることがあります。上の案内からインストールするか、このブラウザを持ち出しに使う確認へチェックしてください。");
  }
  if (!els.travelPairingCode.value.trim()) throw new Error("短期ペアリングコードを入力してください。");
  await travelAdapter.pair(els.travelPairingCode.value.trim(), els.travelDeviceName.value.trim() || "Nexus Ark Lite");
  els.travelPairingCode.value = "";
  await refreshTravelReadiness();
  renderTravelPairingState(true, true);
  setSyncStatus("独立モード端末をペアリングしました。", "ok");
}

function consumePairingHandoff() {
  const handoff = parsePairingHandoff(window.location.href);
  if (!handoff.present) return false;
  window.history.replaceState(window.history.state, "", handoff.cleanUrl);
  els.connectionDetails.open = true;
  els.pairingHandoffNotice.hidden = false;
  if (!handoff.valid) {
    const message = handoff.reason === "expired"
      ? "QRの短期コードは期限切れです。本体で再発行してください。"
      : "QRの短期情報を安全に取り込めませんでした。Lite用クラウドのURLとコードを確認してください。";
    els.pairingHandoffNotice.textContent = message;
    setSyncStatus(message, "warn");
    return true;
  }
  travelAdapter.configure(handoff.workerUrl);
  els.travelWorkerUrl.value = handoff.workerUrl;
  els.travelPairingCode.value = handoff.code;
  els.pairingHandoffNotice.textContent =
    "QRからLite用クラウドのURLと短期コードを取り込みました。この画面の保存領域を確認し、「ペアリング」を押してください。自動では実行しません。";
  setSyncStatus("短期ペアリング情報を取り込みました。内容を確認してからペアリングしてください。", "ok");
  return true;
}

const STANDBY_DATA_PRESETS = {
  recommended: {
    includeCoreMemory: true,
    includeEpisodicMemory: true,
    episodicMemoryDays: 2,
    recentMessageLimit: 40,
    status: "おすすめ: 人柄や最近の出来事、直近の会話をバランスよく持ち出します。",
  },
  minimal: {
    includeCoreMemory: false,
    includeEpisodicMemory: false,
    episodicMemoryDays: 0,
    recentMessageLimit: 0,
    status: "最小限: 会話に必須の人格設定だけを持ち出します。",
  },
};

function applyStandbyDataPreset(preset, { persist = true } = {}) {
  const selected = ["recommended", "minimal", "custom"].includes(preset)
    ? preset
    : "recommended";
  els.standbyDataPreset.value = selected;
  const custom = selected === "custom";
  if (!custom) {
    const values = STANDBY_DATA_PRESETS[selected];
    els.standbyIncludeCoreMemoryCheckbox.checked = values.includeCoreMemory;
    els.standbyIncludeEpisodicMemoryCheckbox.checked = values.includeEpisodicMemory;
    els.standbyEpisodicMemoryDays.value = String(values.episodicMemoryDays);
    els.standbyRecentMessageLimit.value = String(values.recentMessageLimit);
    els.standbyDataPresetStatus.textContent = values.status;
  } else {
    els.standbyDataPresetStatus.textContent =
      "自分で選ぶ: 下の項目で、持ち出す記憶と会話の量を調整できます。";
    els.standbyDataCustomDetails.open = true;
  }
  els.standbyIncludeCoreMemoryCheckbox.disabled = !custom;
  els.standbyIncludeEpisodicMemoryCheckbox.disabled = !custom;
  els.standbyEpisodicMemoryDays.disabled = !custom || !els.standbyIncludeEpisodicMemoryCheckbox.checked;
  els.standbyRecentMessageLimit.disabled = !custom;
  if (persist) localStorage.setItem("nexusLite.standbyDataPreset", selected);
}

async function prepareStandbyFromLite({ automatic = false, silent = false } = {}) {
  if (travelSessionBlocksStandby()) {
    throw new Error(travelSessionStatus() === "returning"
      ? "署名付き帰宅が途中です。「帰宅を再開」で完了してから更新してください。"
      : "独立モードで使用中です。署名付き帰宅後に更新できます。");
  }
  if (!state.homeReachable || !state.roomId) throw new Error("本体接続中に実行してください。");
  const includeCoreMemory = els.standbyIncludeCoreMemoryCheckbox.checked;
  const includeEpisodicMemory = els.standbyIncludeEpisodicMemoryCheckbox.checked;
  const episodicMemoryDays = Math.max(0, Math.min(30, Number(els.standbyEpisodicMemoryDays.value) || 0));
  els.standbyEpisodicMemoryDays.value = String(episodicMemoryDays);
  const recentMessageLimit = Math.max(0, Math.min(40, Number(els.standbyRecentMessageLimit.value) || 0));
  els.standbyRecentMessageLimit.value = String(recentMessageLimit);
  if (!automatic && !silent && !window.confirm(
    `次の範囲をLite用クラウドへ準備します。\n\n人格設定: 含める（必須）\n永続記憶: ${includeCoreMemory ? "含める" : "含めない"}\nエピソード記憶: ${includeEpisodicMemory ? `直近${episodicMemoryDays}日（今日を除く）` : "含めない"}\n直近の会話: 最大${recentMessageLimit}件\n\n続けますか？`
  )) return;
  const manifest = await api("/api/v1/lite-travel/standby", {
    method: "POST",
    body: JSON.stringify({
      room_ids: [state.roomId],
      parallel_room_ids: [],
      retention_days: 7,
      automatic,
      include_core_memory: includeCoreMemory,
      include_episodic_memory: includeEpisodicMemory,
      episodic_memory_days: episodicMemoryDays,
      recent_message_limit: recentMessageLimit,
    }),
    timeoutMs: 120000,
  });
  const skipped = manifest.automatic_skipped === "minimum_interval"
    ? " / 最短間隔内のため据え置き"
    : manifest.automatic_skipped === "unchanged" ? " / 内容変更なし" : "";
  els.standbyStatus.textContent = `お出かけ前のデータ: 世代${manifest.generation} / ${manifest.created_at}${skipped}`;
  rememberLatestStandby(manifest);
  await refreshTravelReadiness();
}

async function maybeAutoRefreshStandby({ forceCheck = false, forceSave = false } = {}) {
  if (
    !els.standbyAutoRefreshCheckbox.checked
    || document.hidden
    || state.mode !== "home"
    || !state.connected
    || !state.homeReachable
    || !state.roomId
    || !travelAdapter.paired()
    || travelSessionBlocksStandby()
    || state.sending
    || state.syncing
    || state.statusRefreshing
    || state.standbyAutoRefreshing
  ) return false;
  const lastAttempt = Number(localStorage.getItem("nexusLite.standbyAutoAttemptAt") || 0);
  if (!forceCheck && Date.now() - lastAttempt < STANDBY_AUTO_CHECK_INTERVAL_MS) return false;
  state.standbyAutoRefreshing = true;
  localStorage.setItem("nexusLite.standbyAutoAttemptAt", String(Date.now()));
  try {
    await prepareStandbyFromLite({ automatic: !forceSave, silent: forceSave });
    return true;
  } finally {
    state.standbyAutoRefreshing = false;
  }
}

async function returnTravelToHome() {
  const session = state.currentTravelSession || state.travelSession;
  if (!session) throw new Error("独立モードsessionがありません。");
  if (!await probeHome()) throw new Error("本体へ接続してから帰宅してください。");
  const resuming = String(session.status) === "returning";
  if (!window.confirm(resuming
    ? "途中の署名付き帰宅を再開し、本体への統合を完了しますか？"
    : "独立モード側の未確定送信を確認し、署名付き差分を本体へ統合しますか？")) return;
  const pending = await travelAdapter.pendingStatus().catch(() => null);
  if (pending && !["completed", "partial", "failed_known"].includes(pending.status)) {
    throw new Error("独立モードの送信結果が未確定です。帰宅を停止しました。");
  }
  state.returningHome = true;
  applyTravelSessionControls();
  try {
    await api("/api/v1/lite-travel/return", {
      method: "POST",
      body: JSON.stringify({ travel_session_id: session.travel_session_id }),
      timeoutMs: 120000,
    });
    state.travelSession = null;
    state.currentTravelSession = null;
    await enterHomeMode();
    await refreshTravelReadiness();
    setSyncStatus("署名付き帰宅を完了し、本体接続へ戻りました。お出かけ前データを更新しています。");
    if (els.standbyAutoRefreshCheckbox.checked) {
      const refreshed = await maybeAutoRefreshStandby({ forceCheck: true, forceSave: true }).catch((error) => {
        els.standbyStatus.textContent = `帰宅は完了しました。お出かけ前データは未保存です: ${error.message}`;
        setSyncStatus("帰宅は完了しました。お出かけ前データは未保存のため、接続を確認して更新してください。", "warn");
        return false;
      });
      if (refreshed) setSyncStatus("署名付き帰宅と、お出かけ前データの更新を完了しました。");
    } else {
      setSyncStatus("署名付き帰宅を完了しました。お出かけ前データは未保存です。必要なら設定から更新してください。", "warn");
    }
  } catch (error) {
    await refreshTravelReadiness().catch(() => {});
    throw error;
  } finally {
    state.returningHome = false;
    applyTravelSessionControls();
    renderSnapshotFreshness();
  }
}

async function handleHomeModeAction() {
  if (travelSessionBlocksStandby() || state.travelSession) {
    await returnTravelToHome();
    return;
  }
  await enterHomeMode();
}

async function sendTravelMessage(message) {
  if (!state.travelSession || !state.travelPersonaId) throw new Error("独立モードsessionがありません。");
  const clientMessageId = `travel_${crypto.randomUUID().replaceAll("-", "_")}`;
  travelAdapter.saveDraft(message);
  appendMessage("user", message);
  const pending = appendMessage("pending", "考えています...");
  const result = await travelAdapter.send(state.travelSession, state.travelPersonaId, message, clientMessageId);
  removeMessage(pending);
  if (result.answer) appendMessage("agent", result.answer);
  if (result.terminal === "response.committed") {
    travelAdapter.saveDraft("");
    els.messageInput.value = "";
    await loadTravelUsage();
  } else {
    throw new Error("送信結果が未確定です。別モードへ自動再送しません。");
  }
}

async function loadAttachmentImage(img, attachmentPath) {
  try {
    const response = await fetch(`${state.apiBase}/api/v1/assets?path=${encodeURIComponent(attachmentPath)}`, {
      headers: authHeaders()
    });
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    img.src = objectUrl;
    img.dataset.fullSrc = objectUrl;
  } catch {
    img.replaceWith(document.createTextNode("画像を読み込めませんでした。"));
  }
}

async function uploadSelectedImage() {
  const file = els.imageInput.files?.[0];
  if (!file) {
    return null;
  }
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${state.apiBase}/api/v1/rooms/${encodeURIComponent(state.roomId)}/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: formData
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${body || response.statusText}`);
  }
  return response.json();
}

function pickAudioMimeType() {
  if (!window.MediaRecorder) {
    return "";
  }
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
}

function setVoiceButton(text, busy = false) {
  els.voiceButton.textContent = text;
  els.voiceButton.disabled = busy;
  els.voiceButton.classList.toggle("is-recording", state.recording);
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(seconds / 60)).padStart(2, "0");
  const sec = String(seconds % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function updateRecordingTimer() {
  if (!state.recordingStartedAt) {
    return;
  }
  const elapsed = Date.now() - state.recordingStartedAt;
  setVoiceButton(`停止 ${formatElapsed(elapsed)} / ${formatElapsed(VOICE_RECORDING_MAX_MS)}`);
}

function startRecordingTimer() {
  state.recordingStartedAt = Date.now();
  updateRecordingTimer();
  clearInterval(state.recordingTimer);
  clearTimeout(state.recordingTimeout);
  state.recordingTimer = setInterval(updateRecordingTimer, 1000);
  state.recordingTimeout = setTimeout(() => {
    if (state.recording && state.mediaRecorder?.state === "recording") {
      setVoiceButton("上限到達", true);
      setSyncStatus("録音上限に達したため、文字起こしを開始します。");
      state.mediaRecorder.stop();
    }
  }, VOICE_RECORDING_MAX_MS);
}

function stopRecordingTimer() {
  clearInterval(state.recordingTimer);
  clearTimeout(state.recordingTimeout);
  state.recordingTimer = null;
  state.recordingTimeout = null;
  state.recordingStartedAt = 0;
}

function appendTranscriptToInput(text) {
  const transcript = String(text || "").trim();
  if (!transcript) {
    return;
  }
  const current = els.messageInput.value.trim();
  els.messageInput.value = current ? `${current}\n${transcript}` : transcript;
  els.messageInput.dispatchEvent(new Event("input"));
  els.messageInput.focus();
}

function stopRecordingStream() {
  for (const track of state.recordingStream?.getTracks?.() || []) {
    track.stop();
  }
  state.recordingStream = null;
}

async function transcribeAudioBlob(blob) {
  if (!state.connected || !state.roomId) {
    throw new Error("APIに接続してください。");
  }
  const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  const formData = new FormData();
  formData.append("file", blob, `voice.${extension}`);
  const response = await fetch(`${state.apiBase}/api/v1/rooms/${encodeURIComponent(state.roomId)}/voice/transcribe`, {
    method: "POST",
    headers: authHeaders(),
    body: formData
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${body || response.statusText}`);
  }
  return response.json();
}

async function synthesizeSpeech(text) {
  if (!state.connected || !state.roomId) {
    throw new Error("APIに接続してください。");
  }
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/tts`, {
    method: "POST",
    body: JSON.stringify({ text, mode: state.ttsMode })
  });
  const audioIds = response.audio_ids?.length ? response.audio_ids : [response.audio_id];
  const blobs = [];
  for (const audioId of audioIds) {
    const audioResponse = await fetch(`${state.apiBase}/api/v1/audio?path=${encodeURIComponent(audioId)}`, {
      headers: authHeaders()
    });
    if (!audioResponse.ok) {
      const body = await audioResponse.text();
      throw new Error(`${audioResponse.status} ${body || audioResponse.statusText}`);
    }
    blobs.push(await audioResponse.blob());
  }
  return {
    blobs,
    notice: response.notice || "",
    segmentCount: response.segment_count || blobs.length
  };
}

function playAudioBlob(blob, label) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    let settled = false;
    state.currentAudio = audio;
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      if (state.currentAudio === audio) {
        state.currentAudio = null;
      }
      if (state.stopCurrentPlayback) {
        state.stopCurrentPlayback = null;
      }
    };
    audio.addEventListener("ended", () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, { once: true });
    audio.addEventListener("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`${label || "音声"}を再生できませんでした。`));
    }, { once: true });
    state.stopCurrentPlayback = () => {
      if (settled) {
        return;
      }
      settled = true;
      state.stopRequested = true;
      audio.pause();
      cleanup();
      resolve();
    };
    audio.play().catch((error) => {
      if (!settled) {
        settled = true;
        cleanup();
      }
      reject(error);
    });
  });
}

function setStopAudioVisible(visible) {
  els.stopAudioButton.hidden = !visible;
}

function stopCurrentAudio() {
  state.stopRequested = true;
  if (state.stopCurrentPlayback) {
    state.stopCurrentPlayback();
  } else if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
  setStopAudioVisible(false);
  setSyncStatus("音声再生を停止しました。");
}

async function playMessageAudio(text, button) {
  const speechText = String(text || "").trim();
  if (!speechText || state.speaking) {
    return;
  }
  state.speaking = true;
  state.stopRequested = false;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "生成中";
  setSyncStatus("音声を生成中...");
  setStopAudioVisible(true);
  let speech = button._pendingSpeech || null;
  try {
    if (state.currentAudio) {
      state.currentAudio.pause();
      state.currentAudio = null;
    }
    if (!speech) {
      speech = await synthesizeSpeech(speechText);
      button._pendingSpeech = speech;
    }
    button.textContent = speech.blobs.length > 1 ? "再生準備完了" : "再生中";
    if (speech.notice) {
      setSyncStatus(speech.notice);
    }
    for (let index = 0; index < speech.blobs.length; index += 1) {
      const total = speech.blobs.length;
      const label = total > 1 ? `${index + 1}/${total}` : "音声";
      button.textContent = total > 1 ? `再生 ${label}` : "再生中";
      setSyncStatus(total > 1 ? `${label}を再生しています。` : "音声を再生しています。");
      await playAudioBlob(speech.blobs[index], label);
      if (state.stopRequested) {
        break;
      }
    }
    if (!state.stopRequested) {
      button._pendingSpeech = null;
      setSyncStatus(speech.notice || "音声を再生しました。");
    }
  } catch (error) {
    if (error.name === "NotAllowedError" && speech) {
      button._pendingSpeech = speech;
      setSyncStatus("音声生成は完了しました。もう一度「再生」を押してください。");
    } else {
      setSyncStatus(`音声再生に失敗しました: ${error.message}`);
    }
  } finally {
    state.speaking = false;
    state.stopRequested = false;
    state.stopCurrentPlayback = null;
    setStopAudioVisible(false);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function finishVoiceRecording() {
  const blob = new Blob(state.audioChunks, { type: state.mediaRecorder?.mimeType || "audio/webm" });
  state.audioChunks = [];
  state.mediaRecorder = null;
  stopRecordingStream();
  stopRecordingTimer();
  state.recording = false;
  if (!blob.size) {
    setVoiceButton("録音");
    setSyncStatus("録音できませんでした。もう一度録音してください。", "warn");
    return;
  }

  state.transcribing = true;
  setVoiceButton("処理中", true);
  setSyncStatus("文字起こし中...");
  try {
    const result = await transcribeAudioBlob(blob);
    if (result.uncertain) {
      setSyncStatus(`低信頼候補: ${result.text || "聞き取れませんでした。"}`);
    } else if (result.text) {
      appendTranscriptToInput(result.text);
      setSyncStatus("文字起こししました。送信前に確認してください。");
    } else {
      setSyncStatus("聞き取れませんでした。もう一度録音してください。", "warn");
    }
  } catch (error) {
    setSyncStatus(`文字起こしに失敗しました: ${error.message}。もう一度録音してください。`, "warn");
  } finally {
    state.transcribing = false;
    setVoiceButton("録音");
  }
}

async function toggleVoiceRecording() {
  if (state.transcribing) {
    return;
  }
  if (state.recording && state.mediaRecorder) {
    setVoiceButton("停止中", true);
    state.mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    renderSecureOriginNotice();
    setSyncStatus("録音にはHTTPSまたはlocalhostが必要です。", "warn");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickAudioMimeType();
    state.audioChunks = [];
    state.recordingStream = stream;
    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) {
        state.audioChunks.push(event.data);
      }
    });
    state.mediaRecorder.addEventListener("stop", () => {
      finishVoiceRecording().catch((error) => setSyncStatus(`文字起こしに失敗しました: ${error.message}`));
    });
    state.mediaRecorder.start();
    state.recording = true;
    startRecordingTimer();
    setSyncStatus("録音中...");
  } catch (error) {
    stopRecordingStream();
    stopRecordingTimer();
    state.recording = false;
    setVoiceButton("録音");
    renderSecureOriginNotice();
    setSyncStatus(`録音を開始できませんでした: ${error.message}`, "warn");
  }
}

function createMessageId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let cursor = 0;
  for (const match of String(text || "").matchAll(pattern)) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }
    if (match[2]) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      parent.appendChild(strong);
    } else if (match[3] && match[4]) {
      const link = document.createElement("a");
      link.href = match[4];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[3];
      parent.appendChild(link);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function linkElementsFromMarkdown(text) {
  const links = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const link = document.createElement("a");
    link.href = match[2];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = match[1];
    links.push(link);
  }
  return links;
}

function renderMusicCard(text) {
  const card = document.createElement("article");
  card.className = "music-card";
  const lines = String(text || "")
    .replace(/^🛠️\s*/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = document.createElement("h3");
  heading.textContent = "音楽推薦カード";
  card.appendChild(heading);

  let currentTrack = null;
  for (const line of lines) {
    if (line === "## 音楽推薦カード") {
      continue;
    }
    const sceneMatch = line.match(/^\*\*気分\/場面:\*\*\s*(.+)$/);
    if (sceneMatch) {
      const meta = document.createElement("p");
      meta.className = "music-card-meta";
      meta.textContent = sceneMatch[1];
      card.appendChild(meta);
      continue;
    }
    const reasonMatch = line.match(/^\*\*推薦したい理由:\*\*\s*(.+)$/);
    if (reasonMatch) {
      const reason = document.createElement("p");
      reason.className = "music-card-reason";
      reason.textContent = reasonMatch[1];
      card.appendChild(reason);
      continue;
    }
    if (line.startsWith("※")) {
      const note = document.createElement("p");
      note.className = "music-card-note";
      note.textContent = line;
      card.appendChild(note);
      continue;
    }
    const trackMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*(?:\s+-\s+(.+))?$/);
    if (trackMatch) {
      currentTrack = document.createElement("section");
      currentTrack.className = "music-track";
      const title = document.createElement("strong");
      title.textContent = trackMatch[1];
      currentTrack.appendChild(title);
      if (trackMatch[2]) {
        const artist = document.createElement("span");
        artist.textContent = trackMatch[2];
        currentTrack.appendChild(artist);
      }
      card.appendChild(currentTrack);
      continue;
    }
    if (currentTrack && line.startsWith("- 理由:")) {
      const reason = document.createElement("p");
      reason.textContent = line.replace(/^- 理由:\s*/, "");
      currentTrack.appendChild(reason);
      continue;
    }
    if (currentTrack && line.startsWith("- 聴く/探す:")) {
      const links = document.createElement("div");
      links.className = "music-links";
      for (const link of linkElementsFromMarkdown(line)) {
        links.appendChild(link);
      }
      currentTrack.appendChild(links);
      continue;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, line);
    card.appendChild(paragraph);
  }
  return card;
}

function renderMessageContent(item, text) {
  if (String(text || "").includes("## 音楽推薦カード")) {
    item.classList.add("music-message");
    item.appendChild(renderMusicCard(applyRedactions(text)));
    return;
  }
  item.innerHTML = applyRedactions(text);
}

function isNearMessageBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 96;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  els.newMessageButton.hidden = true;
}

function formatMessageTimestamp(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function appendMessage(role, text, metadata = {}) {
  const shouldFollow = isNearMessageBottom() || role === "user" || role === "pending";
  const item = document.createElement("div");
  item.className = `message ${role}`;
  renderMessageContent(item, text);
  if (role === "agent" && String(text || "").trim()) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const speakButton = document.createElement("button");
    speakButton.className = "speak-button";
    speakButton.type = "button";
    speakButton.textContent = "再生";
    speakButton.addEventListener("click", () => playMessageAudio(text, speakButton));
    actions.appendChild(speakButton);
    if (metadata.regeneratable && metadata.messageId) {
      const regenerateButton = document.createElement("button");
      regenerateButton.className = "speak-button regenerate-button";
      regenerateButton.type = "button";
      regenerateButton.textContent = "再生成";
      regenerateButton.addEventListener("click", () => regenerateLatestMessage(metadata.messageId, regenerateButton));
      actions.appendChild(regenerateButton);
    }
    item.appendChild(actions);
  }
  const metaParts = [formatMessageTimestamp(metadata.timestamp), metadata.model].filter(Boolean);
  if (metaParts.length) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = metaParts.join(" · ");
    meta.title = metaParts.join(" · ");
    item.appendChild(meta);
  }
  els.messages.appendChild(item);
  if (shouldFollow) {
    scrollMessagesToBottom();
  } else {
    els.newMessageButton.hidden = false;
  }
  return item;
}

function appendHistoryMessage(message, regeneratable = false) {
  const item = appendMessage(message.role || "system", message.content || "", {
    timestamp: message.timestamp,
    model: message.model,
    messageId: message.message_id,
    regeneratable
  });
  appendAttachmentImages(item, message.attachments || []);
  return item;
}

function appendAttachmentImages(item, attachments) {
  for (const attachmentPath of attachments || []) {
    const img = document.createElement("img");
    img.className = "message-image";
    img.alt = "添付画像";
    img.addEventListener("click", () => openImageDialog(img.dataset.fullSrc || img.src));
    item.appendChild(img);
    loadAttachmentImage(img, attachmentPath);
  }
  return item;
}

function openImageDialog(src) {
  if (!src) {
    return;
  }
  els.imageDialogImg.src = src;
  els.imageDialog.showModal();
}

function removeMessage(item) {
  if (item && item.parentElement) {
    item.parentElement.removeChild(item);
  }
}

function clearMessages() {
  els.messages.replaceChildren();
}

function renderChatMessages() {
  clearMessages();
  const messages = state.chatMessages || [];
  let lastAgentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "agent") {
      lastAgentIndex = index;
      break;
    }
  }
  messages.forEach((message, index) => {
    appendHistoryMessage(message, index === lastAgentIndex);
  });
  scrollMessagesToBottom();
}

async function regenerateLatestMessage(messageId, button) {
  if (!state.connected || state.sending || !messageId) {
    return;
  }
  if (!window.confirm("最新の応答を作り直します。アイテム使用などの外部操作は再実行しません。よろしいですか？")) {
    return;
  }
  state.sending = true;
  button.disabled = true;
  button.textContent = "再生成中";
  setSyncStatus("応答を再生成しています...");
  try {
    await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/chat/regenerate`, {
      method: "POST",
      body: JSON.stringify({
        target_message_id: messageId,
        client_message_id: `lite-regen-${createMessageId()}`
      }),
      timeoutMs: 600000
    });
    await loadHistory();
    setSyncStatus("応答を再生成しました。");
  } catch (error) {
    setSyncStatus(`再生成に失敗しました: ${error.message}`, "warn");
    await loadHistory().catch(() => {});
  } finally {
    state.sending = false;
    button.disabled = false;
    button.textContent = "再生成";
  }
}

async function loadHistory() {
  if (!state.roomId) {
    return [];
  }
  const history = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/chat/history?limit=${state.historyLimit}`, { timeoutMs: 15000 });
  state.chatMessages = history.messages || [];
  renderChatMessages();
  updateSendConfirmation(state.chatMessages);
  return state.chatMessages;
}

function updateSendConfirmation(messages) {
  const pending = state.pendingSend;
  if (!pending || pending.roomId !== state.roomId) {
    setSyncStatus("");
    return;
  }
  const sentIndex = messages.findIndex((message) => {
    if (pending.id && message.client_message_id === pending.id) {
      return true;
    }
    return message.role === "user" && String(message.content || "").trim() === pending.message;
  });
  if (sentIndex < 0) {
    updatePendingSendPatch({
      confirmation: "not_found",
      checkedAt: new Date().toISOString(),
      notFoundCount: (Number(pending.notFoundCount) || 0) + 1
    });
    setSyncStatus("前回の送信はまだ履歴で確認できません。");
    return;
  }
  const hasReply = messages.slice(sentIndex + 1).some((message) => message.role === "agent");
  if (hasReply) {
    const shouldNotify = Boolean(pending.notifyOnResponse);
    if (els.messageInput.value.trim() === pending.message) {
      els.messageInput.value = "";
      els.messageInput.style.height = "";
    }
    if (shouldNotify && state.pushSubscriptionCount <= 0) {
      const reply = messages.slice(sentIndex + 1).find((message) => message.role === "agent");
      showLiteNotification("Nexus Ark Lite", responseNotificationBody(reply?.content || ""));
    }
    clearSelectedImage();
    writePendingSend(null);
    setSyncStatus("前回の応答を確認しました。");
    return;
  }
  updatePendingSendPatch({
    confirmation: "sent",
    checkedAt: new Date().toISOString()
  });
  setSyncStatus("前回の送信は記録済みです。応答待ちの可能性があります。");
}

function renderRooms() {
  els.roomSelect.replaceChildren();
  for (const room of state.rooms) {
    const option = document.createElement("option");
    option.value = room.room_id;
    option.textContent = room.display_name || room.room_id;
    els.roomSelect.appendChild(option);
  }
  if (!state.roomId && state.rooms.length) {
    state.roomId = state.rooms[0].room_id;
  }
  if (state.roomId && state.rooms.some((room) => room.room_id === state.roomId)) {
    els.roomSelect.value = state.roomId;
  } else if (state.rooms.length) {
    state.roomId = state.rooms[0].room_id;
    els.roomSelect.value = state.roomId;
  }
  localStorage.setItem("nexusLite.roomId", state.roomId);
}

function setMeter(el, value) {
  el.value = Math.max(0, Math.min(1, Number(value) || 0));
}

function renderStatus(status) {
  els.roomTitle.textContent = status.display_name || status.room_id;
  els.expressionValue.textContent = status.current_expression || "neutral";
  els.arousalValue.textContent = Number(status.arousal ?? 0.5).toFixed(2);
  els.locationValue.textContent = status.current_location || "-";
  setMeter(els.driveBoredom, status.drives?.boredom);
  setMeter(els.driveCuriosity, status.drives?.curiosity);
  setMeter(els.driveGoal, status.drives?.goal_drive);
  setMeter(els.driveRelated, status.drives?.relatedness);
  updatePersonaAvatar(status.profile_image_path);

  const currLoc = status.current_location;
  if (currLoc) {
    for (const option of els.locationSelect.options) {
      const parts = option.textContent.split(" / ");
      const nameOnly = parts[parts.length - 1];
      if (option.value === currLoc || nameOnly === currLoc || option.textContent === currLoc) {
        option.selected = true;
        break;
      }
    }
  }
}

async function updatePersonaAvatar(imagePath) {
  if (!els.personaAvatar) {
    return;
  }
  if (!imagePath) {
    if (els.personaAvatar.src && els.personaAvatar.src.startsWith("blob:")) {
      URL.revokeObjectURL(els.personaAvatar.src);
    }
    els.personaAvatar.hidden = true;
    els.personaAvatar.src = "";
    return;
  }
  try {
    const response = await fetch(`${state.apiBase}/api/v1/assets?path=${encodeURIComponent(imagePath)}`, {
      headers: authHeaders()
    });
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (els.personaAvatar.src && els.personaAvatar.src.startsWith("blob:")) {
      URL.revokeObjectURL(els.personaAvatar.src);
    }
    els.personaAvatar.src = objectUrl;
    els.personaAvatar.hidden = false;
  } catch (error) {
    console.error("Failed to load persona avatar:", error);
    els.personaAvatar.hidden = true;
    els.personaAvatar.src = "";
  }
}

async function refreshStatus() {
  if (!state.roomId || !state.connected || state.mode !== "home" || state.statusRefreshing) {
    return;
  }
  state.statusRefreshing = true;
  try {
    const status = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/status`, { timeoutMs: 15000 });
    renderStatus(status);
  } finally {
    state.statusRefreshing = false;
  }
}

function setManagementStatus(text, mode = "idle") {
  els.managementSummaryStatus.textContent = text;
  els.managementSummaryStatus.dataset.mode = mode;
}

function setLetterboxStatus(text, mode = "idle") {
  els.letterboxSummaryStatus.textContent = text;
  els.letterboxSummaryStatus.dataset.mode = mode;
}

function formatLetterDatetime(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function renderLetterbox(response) {
  els.letterboxList.replaceChildren();
  els.letterboxReader.hidden = true;
  const letters = response.letters || [];
  if (!letters.length) {
    const empty = document.createElement("li");
    empty.className = "letterbox-empty";
    empty.textContent = "手紙はまだありません。";
    els.letterboxList.appendChild(empty);
    return;
  }
  for (const letter of letters) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "letterbox-item";
    if (!letter.read) {
      button.classList.add("unread");
    }
    const title = document.createElement("span");
    title.className = "letterbox-item-title";
    title.textContent = `${letter.read ? "" : "● "}${letter.title}`;
    const meta = document.createElement("span");
    meta.className = "letterbox-item-meta";
    meta.textContent = formatLetterDatetime(letter.created_at);
    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener("click", () => openLetter(letter.id, button));
    item.appendChild(button);
    els.letterboxList.appendChild(item);
  }
}

async function openLetter(letterId, button) {
  try {
    const letter = await api(
      `/api/v1/rooms/${encodeURIComponent(state.roomId)}/letters/${encodeURIComponent(letterId)}`
    );
    els.letterboxReaderTitle.textContent = letter.title;
    els.letterboxReaderMeta.textContent = `届いた日時: ${formatLetterDatetime(letter.created_at)}`;
    els.letterboxReaderBody.textContent = letter.body;
    els.letterboxReader.hidden = false;
    if (button) {
      button.classList.remove("unread");
      const title = button.querySelector(".letterbox-item-title");
      if (title) {
        title.textContent = letter.title;
      }
    }
    // 開いた手紙はサーバー側で既読になるため、未読数の表示を更新する
    const unread = els.letterboxList.querySelectorAll(".letterbox-item.unread").length;
    setLetterboxStatus(unread > 0 ? `未読 ${unread}` : "未読なし", unread > 0 ? "ok" : "idle");
    els.letterboxReader.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    setSyncStatus(`手紙の取得に失敗しました: ${error.message}`, "warn");
  }
}

async function refreshLetterbox() {
  if (!state.connected || !state.roomId || !els.managementDetails?.open) {
    return;
  }
  setLetterboxStatus("読込中", "busy");
  els.letterboxRefreshButton.disabled = true;
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/letters?limit=100`);
    renderLetterbox(response);
    const unread = response.unread_count || 0;
    setLetterboxStatus(unread > 0 ? `未読 ${unread}` : "未読なし", unread > 0 ? "ok" : "idle");
  } catch (error) {
    setLetterboxStatus("失敗", "error");
    setSyncStatus(`手紙箱の取得に失敗しました: ${error.message}`, "warn");
  } finally {
    els.letterboxRefreshButton.disabled = false;
  }
}

function selectedDraft() {
  return state.twitterDrafts.find((draft) => draft.id === els.draftSelect.value) || null;
}

function renderSelectedDraft() {
  const draft = selectedDraft();
  els.draftMediaGrid.replaceChildren();
  els.draftContent.value = draft?.content || "";
  els.draftContent.disabled = !draft;
  els.draftApproveButton.disabled = !draft;
  els.draftRejectButton.disabled = !draft;
  if (!draft) {
    els.draftMeta.textContent = "承認待ち下書きはありません。";
    return;
  }
  const warningText = draft.warnings?.length ? ` / ${draft.warnings.join(" / ")}` : "";
  const mediaText = draft.media_paths?.length ? ` / 添付 ${draft.media_paths.length}件` : "";
  els.draftMeta.textContent = `${draft.twitter_length}/${draft.limit}${mediaText}${warningText}`;
  for (const path of draft.media_paths || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "draft-media-button";
    button.title = "添付画像を拡大";
    const img = document.createElement("img");
    img.alt = "Twitter下書きの添付画像";
    button.appendChild(img);
    button.addEventListener("click", () => openImageDialog(img.dataset.fullSrc || img.src));
    els.draftMediaGrid.appendChild(button);
    loadAttachmentImage(img, path);
  }
}

function renderTwitterDrafts(drafts) {
  state.twitterDrafts = drafts || [];
  els.draftSelect.replaceChildren();
  if (!state.twitterDrafts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "承認待ちなし";
    els.draftSelect.appendChild(option);
    renderSelectedDraft();
    return;
  }
  for (const draft of state.twitterDrafts) {
    const option = document.createElement("option");
    option.value = draft.id;
    const preview = String(draft.content || "").replace(/\s+/g, " ").slice(0, 32);
    const media = draft.media_paths?.length ? ` 📷${draft.media_paths.length}` : "";
    option.textContent = `${draft.timestamp ? draft.timestamp.slice(5, 16).replace("T", " ") : draft.id}${media} ${preview}`;
    els.draftSelect.appendChild(option);
  }
  renderSelectedDraft();
}

async function loadTwitterDrafts() {
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/twitter/drafts`);
  renderTwitterDrafts(response.drafts || []);
  return response.drafts?.length || 0;
}

function renderLocations(response) {
  els.locationSelect.replaceChildren();
  if (!response.locations?.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "移動先なし";
    els.locationSelect.appendChild(option);
    return;
  }
  for (const location of response.locations || []) {
    const option = document.createElement("option");
    option.value = location.id;
    option.textContent = location.area ? `${location.area} / ${location.name}` : location.name;
    els.locationSelect.appendChild(option);
    if (location.name === response.current_location || location.id === response.current_location) {
      option.selected = true;
    }
  }
}

async function loadLocations() {
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/locations`);
  renderLocations(response);
}

function renderAutonomy(response) {
  const stateText = response.enabled ? "通常" : "静か";
  els.autonomyMeta.textContent = `${stateText} / 間隔 ${response.inactivity_minutes}分 / 静穏 ${response.quiet_hours_start}-${response.quiet_hours_end}`;
  els.autonomyQuietButton.disabled = !response.enabled;
  els.autonomyNormalButton.disabled = response.enabled;
}

async function loadAutonomy() {
  const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/autonomy`);
  renderAutonomy(response);
}

function formatNoteDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setNoteEditing(editing) {
  state.noteEditing = editing;
  els.noteViewer.hidden = editing;
  els.noteEditor.hidden = !editing;
  els.noteEditButton.hidden = editing;
  els.noteSaveButton.hidden = !editing;
  els.noteCancelButton.hidden = !editing;
  els.noteRefreshButton.disabled = editing;
  els.noteTypeSelect.disabled = editing;
  els.noteHeadingSelect.disabled = editing || !els.noteHeadingSelect.options.length;
  els.noteShowSectionButton.disabled = editing || !els.noteHeadingSelect.value;
}

function renderNote(response) {
  const content = String(response.content || "").trim();
  els.noteViewer.textContent = content || "このノートは空です。";
  const sizeKb = Math.max(0, Number(response.size || 0) / 1024).toFixed(1);
  els.noteMeta.textContent = `${response.title || "ノート"} / 更新 ${formatNoteDate(response.updated_at)} / ${sizeKb}KB`;
  state.currentNote = {
    type: response.note_type || els.noteTypeSelect.value || "research",
    content: String(response.content || ""),
    contentHash: response.content_hash || "",
    editable: Boolean(response.editable)
  };
  els.noteEditButton.disabled = !state.currentNote.editable;
  if (state.noteEditing) {
    els.noteEditor.value = state.currentNote.content;
  }
}

async function loadNoteHeadings() {
  if (!state.connected || !state.roomId) {
    return;
  }
  els.noteRefreshButton.disabled = true;
  els.noteMeta.textContent = "見出し取得中";
  setNoteEditing(false);
  try {
    const noteType = els.noteTypeSelect.value || "research";
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/notes/${encodeURIComponent(noteType)}?headings_only=true`, {
      timeoutMs: 8000
    });
    const headings = response.headings || [];
    els.noteHeadingSelect.replaceChildren();
    if (!headings.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "（見出しなし）";
      els.noteHeadingSelect.appendChild(option);
      els.noteHeadingSelect.disabled = true;
      els.noteShowSectionButton.disabled = true;
      const fullResponse = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/notes/${encodeURIComponent(noteType)}`, {
        timeoutMs: 8000
      });
      renderNote(fullResponse);
    } else {
      const allOption = document.createElement("option");
      allOption.value = "__all__";
      allOption.textContent = `全文表示（${headings.length}件の見出し）`;
      els.noteHeadingSelect.appendChild(allOption);
      for (const heading of headings) {
        const option = document.createElement("option");
        option.value = heading;
        option.textContent = heading.replace(/^#+\s*/, "");
        els.noteHeadingSelect.appendChild(option);
      }
      els.noteHeadingSelect.disabled = false;
      els.noteShowSectionButton.disabled = false;
      els.noteViewer.textContent = "見出しを選んで「表示」を押してください。";
      state.currentNote = null;
      els.noteEditButton.disabled = !response.editable;
    }
    const sizeKb = Math.max(0, Number(response.size || 0) / 1024).toFixed(1);
    els.noteMeta.textContent = `${response.title || "ノート"} / ${sizeKb}KB / ${headings.length}見出し`;
  } catch (error) {
    els.noteMeta.textContent = "失敗";
    els.noteViewer.textContent = `見出しを読み込めませんでした: ${error.message}`;
  } finally {
    els.noteRefreshButton.disabled = false;
  }
}

async function loadNoteSection() {
  if (!state.connected || !state.roomId) {
    return;
  }
  const selectedHeading = els.noteHeadingSelect.value;
  if (!selectedHeading) {
    return;
  }
  els.noteShowSectionButton.disabled = true;
  els.noteViewer.textContent = "読込中...";
  try {
    const noteType = els.noteTypeSelect.value || "research";
    let url = `/api/v1/rooms/${encodeURIComponent(state.roomId)}/notes/${encodeURIComponent(noteType)}`;
    if (selectedHeading !== "__all__") {
      url += `?heading=${encodeURIComponent(selectedHeading)}`;
    }
    const response = await api(url, { timeoutMs: 15000 });
    const content = String(response.content || "").trim();
    els.noteViewer.textContent = content || "このセクションは空です。";
    state.currentNote = {
      type: response.note_type || noteType,
      content: selectedHeading === "__all__" ? String(response.content || "") : "",
      contentHash: response.content_hash || "",
      editable: Boolean(response.editable)
    };
    els.noteEditButton.disabled = !response.editable;
    const sizeKb = Math.max(0, Number(response.size || 0) / 1024).toFixed(1);
    els.noteMeta.textContent = `${response.title || "ノート"} / 更新 ${formatNoteDate(response.updated_at)} / ${sizeKb}KB`;
  } catch (error) {
    els.noteViewer.textContent = `ノートを読み込めませんでした: ${error.message}`;
  } finally {
    els.noteShowSectionButton.disabled = false;
  }
}

async function startNoteEdit() {
  if (!["research", "creative"].includes(els.noteTypeSelect.value) || (state.currentNote && !state.currentNote.editable)) {
    return;
  }
  if (!state.connected || !state.roomId) {
    return;
  }
  els.noteEditButton.disabled = true;
  els.noteMeta.textContent = "全文読込中";
  try {
    const noteType = els.noteTypeSelect.value || "research";
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/notes/${encodeURIComponent(noteType)}`, {
      timeoutMs: 15000
    });
    renderNote(response);
    els.noteEditor.value = String(response.content || "");
    setNoteEditing(true);
    els.noteMeta.textContent = `${response.title || "ノート"} / 編集中`;
  } catch (error) {
    els.noteViewer.textContent = `ノートを編集用に読み込めませんでした: ${error.message}`;
  } finally {
    els.noteEditButton.disabled = false;
  }
}

function cancelNoteEdit() {
  setNoteEditing(false);
  if (state.currentNote) {
    els.noteViewer.textContent = state.currentNote.content || "このノートは空です。";
  }
}

async function saveNoteEdit() {
  if (!state.connected || !state.roomId || !state.currentNote) {
    return;
  }
  els.noteSaveButton.disabled = true;
  els.noteCancelButton.disabled = true;
  els.noteMeta.textContent = "保存中";
  const noteType = state.currentNote.type || els.noteTypeSelect.value || "research";
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/notes/${encodeURIComponent(noteType)}`, {
      method: "PUT",
      timeoutMs: 15000,
      body: JSON.stringify({
        content: els.noteEditor.value,
        base_hash: state.currentNote.contentHash || null
      })
    });
    renderNote(response);
    setNoteEditing(false);
    els.noteMeta.textContent = `${response.title || "ノート"} / 保存しました`;
  } catch (error) {
    const message = String(error.message || "");
    if (message.startsWith("409 ")) {
      els.noteMeta.textContent = "他の場所で更新されています。再読込してください。";
      setSyncStatus("ノートは保存されていません。再読込してから編集し直してください。", "warn");
    } else {
      els.noteMeta.textContent = `保存失敗: ${message}`;
    }
  } finally {
    els.noteSaveButton.disabled = false;
    els.noteCancelButton.disabled = false;
  }
}

function selectedItem() {
  return state.items.find((item) => item.id === els.itemSelect.value) || null;
}

function renderItemActions() {
  const target = els.itemTargetSelect.value;
  const options = target === "location"
    ? [["pickup", "拾う"], ["consume_location", "その場で使う"]]
    : [["gift", "ペルソナに贈る"], ["consume", "自分で使う"], ["place", "現在地に置く"]];
  const previous = els.itemActionSelect.value;
  els.itemActionSelect.replaceChildren();
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    els.itemActionSelect.appendChild(option);
  }
  if (options.some(([value]) => value === previous)) {
    els.itemActionSelect.value = previous;
  }
  els.itemFurnitureField.hidden = els.itemActionSelect.value !== "place";
}

function renderItemPreview() {
  const item = selectedItem();
  els.itemPreview.replaceChildren();
  if (!item) {
    els.itemDetail.textContent = "利用できるアイテムがありません。";
    els.itemExecuteButton.disabled = true;
    return;
  }
  els.itemExecuteButton.disabled = false;
  if (item.image_path) {
    const img = document.createElement("img");
    img.alt = item.name || "アイテム画像";
    img.addEventListener("click", () => openImageDialog(img.dataset.fullSrc || img.src));
    els.itemPreview.appendChild(img);
    loadAttachmentImage(img, item.image_path);
  }
  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${item.name || "アイテム"} ×${item.amount}`;
  const description = document.createElement("p");
  description.textContent = item.description || item.category || "詳細なし";
  text.append(title, description);
  els.itemPreview.appendChild(text);
  els.itemDetail.textContent = item.furniture ? `配置場所: ${item.furniture}` : "操作内容を選んで実行してください。";
}

async function loadItems() {
  if (!state.connected || !state.roomId) {
    return;
  }
  els.itemRefreshButton.disabled = true;
  els.itemDetail.textContent = "アイテムを読み込んでいます...";
  try {
    const target = els.itemTargetSelect.value;
    const location = target === "location" ? els.locationSelect.value : "";
    const response = await api(
      `/api/v1/rooms/${encodeURIComponent(state.roomId)}/items?target=${encodeURIComponent(target)}&location=${encodeURIComponent(location)}`,
      { timeoutMs: 10000 }
    );
    state.items = response.items || [];
    els.itemSelect.replaceChildren();
    for (const item of state.items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name || item.id} ×${item.amount}${item.furniture ? ` / ${item.furniture}` : ""}`;
      els.itemSelect.appendChild(option);
    }
    renderItemActions();
    renderItemPreview();
  } catch (error) {
    state.items = [];
    els.itemSelect.replaceChildren();
    els.itemDetail.textContent = `アイテムを取得できませんでした: ${error.message}`;
    els.itemExecuteButton.disabled = true;
  } finally {
    els.itemRefreshButton.disabled = false;
  }
}

async function openItemDialog() {
  if (!state.connected || !state.roomId) {
    setSyncStatus("APIに接続してください。", "warn");
    return;
  }
  els.itemDialog.showModal();
  await loadItems();
}

async function executeItemAction() {
  const item = selectedItem();
  if (!item || state.sending) {
    return;
  }
  const actionLabel = els.itemActionSelect.selectedOptions[0]?.textContent || "操作";
  const amount = Math.max(1, Number(els.itemAmountInput.value || 1));
  if (!window.confirm(`「${item.name}」を${amount}個、${actionLabel}します。よろしいですか？`)) {
    return;
  }
  els.itemExecuteButton.disabled = true;
  els.itemExecuteButton.textContent = "実行中";
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/items/actions`, {
      method: "POST",
      body: JSON.stringify({
        action: els.itemActionSelect.value,
        item_id: item.id,
        amount,
        location: els.locationSelect.value || "",
        furniture: els.itemActionSelect.value === "place" ? els.itemFurnitureInput.value.trim() : (item.furniture || ""),
        client_action_id: `lite-item-${createMessageId()}`
      }),
      timeoutMs: 20000
    });
    els.itemDialog.close();
    els.messageInput.value = response.chat_context || `${item.name}を使いました。`;
    state.preparedChatAttachments = (
      ["consume", "consume_location"].includes(response.action) && response.item?.image_path
    ) ? [response.item.image_path] : [];
    saveComposerDraft();
    setActivePage("chat");
    els.chatForm.requestSubmit();
  } catch (error) {
    els.itemDetail.textContent = `アイテム操作に失敗しました: ${error.message}`;
  } finally {
    els.itemExecuteButton.disabled = false;
    els.itemExecuteButton.textContent = "実行して話す";
  }
}

function renderEventNotificationSettings(response) {
  els.eventNotificationEnabled.checked = Boolean(response.enabled);
  state.responsePreviewEnabled = response.response_preview_enabled !== false;
  els.responsePreviewEnabled.checked = state.responsePreviewEnabled;
  els.eventNotificationMinimum.value = response.minimum_importance || "high";
  els.eventNotificationCooldown.value = String(response.default_cooldown_seconds ?? 300);
  els.eventNotificationSourceCooldowns.value = JSON.stringify(response.source_cooldowns || {}, null, 2);
}

async function loadEventNotificationSettings() {
  const response = await api("/api/v1/notifications/events/settings");
  renderEventNotificationSettings(response);
}

function readSourceCooldownsInput() {
  const raw = els.eventNotificationSourceCooldowns.value.trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("送信元別の通知間隔JSONはオブジェクトで入力してください。");
  }
  const normalized = {};
  for (const [source, seconds] of Object.entries(parsed)) {
    const key = String(source || "").trim();
    const value = Number(seconds);
    if (!key || !Number.isFinite(value) || value < 0 || value > 86400) {
      throw new Error("送信元別の通知間隔は 0-86400 秒の数値で入力してください。");
    }
    normalized[key] = Math.trunc(value);
  }
  return normalized;
}

async function saveEventNotificationSettings() {
  els.eventNotificationSaveButton.disabled = true;
  try {
    const cooldown = Number(els.eventNotificationCooldown.value);
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 86400) {
      throw new Error("既定クールダウン秒は 0-86400 で入力してください。");
    }
    const response = await api("/api/v1/notifications/events/settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: els.eventNotificationEnabled.checked,
        response_preview_enabled: els.responsePreviewEnabled.checked,
        minimum_importance: els.eventNotificationMinimum.value,
        default_cooldown_seconds: Math.trunc(cooldown),
        source_cooldowns: readSourceCooldownsInput()
      })
    });
    renderEventNotificationSettings(response);
    setNotificationDetail(`通知設定を保存しました: 外部イベント通知 ${response.enabled ? "ON" : "OFF"} / ${response.minimum_importance}以上`);
  } catch (error) {
    setNotificationDetail(`通知設定の保存に失敗しました: ${error.message}`, "warn");
  } finally {
    els.eventNotificationSaveButton.disabled = false;
  }
}

async function refreshManagement({ force = false } = {}) {
  if (!state.connected || !state.roomId || !els.managementDetails.open) {
    return;
  }
  if (state.managementLoaded && !force) {
    return;
  }
  setManagementStatus("読込中", "busy");
  els.draftRefreshButton.disabled = true;
  try {
    const draftCount = await loadTwitterDrafts();
    await loadAutonomy();
    await loadNoteHeadings();
    await loadEventNotificationSettings();
    state.managementLoaded = true;
    setManagementStatus(`下書き ${draftCount}`, "ok");
  } catch (error) {
    setManagementStatus("失敗", "error");
    setSyncStatus(`管理情報の取得に失敗しました: ${error.message}`, "warn");
  } finally {
    els.draftRefreshButton.disabled = false;
  }
}

async function approveSelectedDraft() {
  const draft = selectedDraft();
  if (!draft) {
    return;
  }
  const content = els.draftContent.value.trim();
  if (!content) {
    setSyncStatus("投稿内容が空です。", "warn");
    return;
  }
  if (!window.confirm("この下書きを承認して投稿しますか？")) {
    return;
  }
  els.draftApproveButton.disabled = true;
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/twitter/drafts/${encodeURIComponent(draft.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({
        content,
        reply_to_url: draft.reply_to_url || null,
        media_paths: draft.media_paths || []
      })
    });
    setSyncStatus(response.error || response.detail || "Twitter下書きを処理しました。", response.error ? "warn" : "idle");
    state.managementLoaded = false;
    await refreshManagement({ force: true });
  } catch (error) {
    setSyncStatus(`Twitter承認に失敗しました: ${error.message}`, "warn");
  } finally {
    els.draftApproveButton.disabled = false;
  }
}

async function rejectSelectedDraft() {
  const draft = selectedDraft();
  if (!draft || !window.confirm("この下書きを却下しますか？")) {
    return;
  }
  els.draftRejectButton.disabled = true;
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/twitter/drafts/${encodeURIComponent(draft.id)}/reject`, {
      method: "POST"
    });
    setSyncStatus(response.detail || "Twitter下書きを却下しました。");
    state.managementLoaded = false;
    await refreshManagement({ force: true });
  } catch (error) {
    setSyncStatus(`Twitter却下に失敗しました: ${error.message}`, "warn");
  } finally {
    els.draftRejectButton.disabled = false;
  }
}

async function setSelectedLocation() {
  if (!els.locationSelect.value) {
    return;
  }
  els.locationSelect.disabled = true;
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/location`, {
      method: "POST",
      body: JSON.stringify({ location_id: els.locationSelect.value })
    });
    setSyncStatus("現在地を更新しました。");
    await refreshStatus();
    await loadLocations();
  } catch (error) {
    setSyncStatus(`現在地の更新に失敗しました: ${error.message}`, "warn");
  } finally {
    els.locationSelect.disabled = false;
  }
}

async function setAutonomyPreset(preset) {
  els.autonomyQuietButton.disabled = true;
  els.autonomyNormalButton.disabled = true;
  try {
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/autonomy/preset`, {
      method: "POST",
      body: JSON.stringify({ preset })
    });
    renderAutonomy(response);
    setSyncStatus(response.status || "自律行動設定を更新しました。");
    await refreshStatus();
  } catch (error) {
    setSyncStatus(`自律行動設定の更新に失敗しました: ${error.message}`, "warn");
  } finally {
    els.autonomyQuietButton.disabled = false;
    els.autonomyNormalButton.disabled = false;
    renderAutonomy(await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/autonomy`).catch(() => ({
      enabled: preset !== "quiet",
      inactivity_minutes: 120,
      schedule_cooldown_minutes: 60,
      quiet_hours_start: "00:00",
      quiet_hours_end: "07:00"
    })));
  }
}

async function syncNow() {
  if (state.mode === "travel") {
    await loadTravelHistory();
    setSyncStatus("独立モード履歴を再取得しました。");
    return;
  }
  if (!state.connected || !state.roomId) {
    return;
  }
  if (els.syncButton) {
    els.syncButton.disabled = true;
  }
  setSyncStatus("履歴を再取得中...");
  try {
    await loadHistory();
    await refreshStatus();
    state.managementLoaded = false;
    setConnectionStatus("接続済み", "ok");
    refreshManagement({ force: true }).catch((error) => setSyncStatus(`管理情報の取得に失敗しました: ${error.message}`, "warn"));
  } finally {
    if (els.syncButton) {
      els.syncButton.disabled = false;
    }
  }
}

async function refreshConnectionExtras() {
  const tasks = [];
  if (Notification.permission === "granted") {
    tasks.push(
      subscribeWebPush().catch((error) => {
        setSyncStatus(`Push購読を保存できませんでした: ${error.message}`, "warn");
      }),
      refreshPushStatus().catch(() => {})
    );
  }
  state.managementLoaded = false;
  tasks.push(refreshManagement({ force: true }));
  await Promise.allSettled(tasks);
}

async function loadPrimaryRoomData() {
  let history;
  try {
    history = await loadHistory();
  } catch (firstError) {
    const message = String(firstError?.message || "");
    if (message.startsWith("401 ") || message.startsWith("403 ")) throw firstError;
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    history = await loadHistory();
  }

  const auxiliary = await Promise.allSettled([refreshStatus(), loadLocations()]);
  const failed = auxiliary.filter((result) => result.status === "rejected");
  if (failed.length) {
    const detail = failed.map((result) => result.reason?.message || "unknown").join(" / ");
    setSyncStatus(`チャットは接続済みです。補助情報の一部を取得できませんでした: ${detail}`, "warn");
  }
  return history;
}

async function connect({ collapse = true, useInputs = false } = {}) {
  if (useInputs) {
    state.apiBase = normalizeBase(els.apiBaseInput.value) || homeDefaultBase();
    state.token = els.tokenInput.value.trim();
    writeConnectionValue("nexusLite.apiBase", state.apiBase);
    writeConnectionValue("nexusLite.token", state.token);
  } else {
    state.apiBase = state.apiBase || initialHomeBase();
    state.token = state.token || readConnectionValue("nexusLite.token");
  }
  updateConnectionSummary();
  renderSecureOriginNotice();
  if (!state.apiBase) {
    setConnectionStatus("本体接続は未設定です", "warn");
    throw new Error("本体のAPI URLを入力してください。独立モードのみ使う場合は、下のLite用クラウドの状態を確認してください。");
  }
  setConnectionStatus("接続中", "busy");
  els.connectButton.disabled = true;
  try {
    try {
      state.rooms = await api("/api/v1/rooms", { timeoutMs: 15000 });
    } catch (firstError) {
      const message = String(firstError?.message || "");
      if (message.startsWith("401 ") || message.startsWith("403 ")) throw firstError;
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      state.rooms = await api("/api/v1/rooms", { timeoutMs: 15000 });
    }
    state.homeReachable = true;
    renderRooms();
    restoreComposerDraft();
    state.connected = true;
    setConnectionStatus("接続済み", "ok");
    setConnectivityStep("home", "connected", "ok", "接続済み", "次にLite用クラウドの状態を確認します。");
    setSyncStatus("状態と履歴を取得中...");
    await loadPrimaryRoomData();
    if (collapse) {
      els.connectionDetails.open = false;
    }
    refreshConnectionExtras().catch((error) => setSyncStatus(`補助情報の取得に失敗しました: ${error.message}`, "warn"));
  } catch (error) {
    state.connected = false;
    throw error;
  } finally {
    els.connectButton.disabled = false;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const message = els.messageInput.value.trim();
  if (state.mode === "travel") {
    if (
      !message ||
      state.sending ||
      state.travelRouteChanging ||
      !state.travelRouteUsable ||
      state.travelBudgetStopped
    ) return;
    state.sending = true;
    setTravelRouteControls();
    try {
      await sendTravelMessage(message);
      setSyncStatus("独立モードの応答を受信しました。本体へ自動切替しません。");
    } catch (error) {
      els.messageInput.value = message;
      travelAdapter.saveDraft(message);
      setSyncStatus(error.message, "warn");
    } finally {
      state.sending = false;
      setTravelRouteControls();
    }
    return;
  }
  const selectedFile = els.imageInput.files?.[0] || null;
  const preparedAttachments = [...(state.preparedChatAttachments || [])];
  if ((!message && !selectedFile) || !state.roomId || state.sending) {
    return;
  }
  const submitKey = `${state.roomId}\n${message}\n${selectedFile?.name || ""}\n${selectedFile?.size || 0}\n${preparedAttachments.join("\n")}`;
  const now = Date.now();
  if (state.lastSubmitKey === submitKey && now - (state.lastSubmitAt || 0) < RECENT_SUBMIT_GUARD_MS) {
    return;
  }
  state.lastSubmitKey = submitKey;
  state.lastSubmitAt = now;
  if (state.pendingSend && state.pendingSend.roomId === state.roomId) {
    appendMessage("system", "前回の送信結果を確認中です。再送する前に履歴を再取得します。");
    try {
      await syncNow();
    } catch {
      setSyncStatus("前回の送信結果を確認できません。通信状態を確認してください。");
    }
    if (state.pendingSend && state.pendingSend.roomId === state.roomId) {
      if (canReleaseUnconfirmedPending(state.pendingSend)) {
        appendMessage("system", "前回の送信は履歴に見つかりませんでした。保留状態を解除して送信します。");
        writePendingSend(null);
      } else {
        return;
      }
    }
  }
  state.sending = true;
  const clientMessageId = createMessageId();
  writePendingSend({
    id: clientMessageId,
    roomId: state.roomId,
    message,
    file: selectedFileSignature(selectedFile),
    attachments: preparedAttachments,
    confirmation: "sending",
    notifyOnResponse: document.hidden || !document.hasFocus(),
    sentAt: new Date().toISOString()
  });
  setSyncStatus("送信中...");
  els.messageInput.value = "";
  localStorage.removeItem(draftStorageKey());
  els.messageInput.style.height = "";
  els.sendButton.disabled = true;
  els.sendButton.textContent = "送信中";
  appendMessage("user", selectedFile ? `${message || "画像を送ります。"}\n[添付: ${selectedFile.name}]` : message);
  const pendingMessage = appendMessage("pending", "考えています...");
  try {
    const uploaded = await uploadSelectedImage();
    const attachments = [...preparedAttachments];
    if (uploaded) attachments.push(uploaded.attachment_id);
    const response = await api(`/api/v1/rooms/${encodeURIComponent(state.roomId)}/chat`, {
      method: "POST",
      body: JSON.stringify({
        user_id: "mobile_lite",
        message: message || "添付画像を見てください。",
        source: "mobile_lite",
        stream: false,
        attachments,
        client_message_id: clientMessageId
      })
    });
    removeMessage(pendingMessage);
    clearSelectedImage();
    state.preparedChatAttachments = [];
    setSyncStatus("応答を受信しました。");
    await notifyResponseIfWanted(responseNotificationBody(response.reply || ""));
    writePendingSend(null);
    try {
      await loadHistory();
    } catch {
      const agentMessage = appendMessage("agent", response.reply || "（応答なし）", {
        timestamp: response.timestamp,
        model: response.model
      });
      appendAttachmentImages(agentMessage, response.attachments || []);
    }
    await refreshStatus();
  } catch (error) {
    removeMessage(pendingMessage);
    els.messageInput.value = message;
    state.preparedChatAttachments = preparedAttachments;
    saveComposerDraft();
    appendMessage("system", "通信が中断されました。↻ ボタンで履歴を再読み込みしてください。");
    setSyncStatus("送信結果を確認できません。↻ ボタンで再読み込みしてください。");
    if (!document.hidden) {
      try {
        await syncNow();
      } catch {
        // 回線復帰前なら、次の画面復帰時に再同期する。
      }
    }
  } finally {
    state.sending = false;
    els.sendButton.disabled = false;
    els.sendButton.textContent = "送信";
  }
}

els.apiBaseInput.value = state.apiBase;
els.tokenInput.value = state.token;
els.ttsModeSelect.value = state.ttsMode === "split" ? "split" : "trim";
updateConnectionSummary();
renderSecureOriginNotice();
els.connectButton.addEventListener("click", () => connect({ collapse: true, useInputs: true }).catch((error) => {
  els.connectButton.disabled = false;
  showConnectionError(error);
}));
const handleRefresh = async () => {
  if (state.syncing) {
    return;
  }
  state.syncing = true;
  try {
    if (!state.connected) {
      await connect({ collapse: true, useInputs: false });
    } else {
      await syncNow();
    }
  } finally {
    state.syncing = false;
  }
};

els.refreshButton.addEventListener("click", () => handleRefresh().catch((error) => showConnectionError(error)));
els.loadMoreButton.addEventListener("click", async () => {
  state.historyLimit = Math.min(50, state.historyLimit + 20);
  els.loadMoreButton.disabled = true;
  try {
    await loadHistory();
    setSyncStatus(`直近${state.historyLimit}件を表示しています。`);
  } finally {
    els.loadMoreButton.disabled = state.historyLimit >= 50;
  }
});
els.newMessageButton.addEventListener("click", scrollMessagesToBottom);
if (els.syncButton) {
  els.syncButton.addEventListener("click", () => handleRefresh().catch((error) => {
    setSyncStatus("再取得に失敗しました。");
    showConnectionError(error);
  }));
}
els.ttsModeSelect.addEventListener("change", () => {
  state.ttsMode = els.ttsModeSelect.value === "split" ? "split" : "trim";
  localStorage.setItem("nexusLite.ttsMode", state.ttsMode);
});
els.stopAudioButton.addEventListener("click", stopCurrentAudio);
els.roomSelect.addEventListener("change", async () => {
  if (state.mode === "travel") {
    if (state.sending || state.travelRouteChanging) {
      els.roomSelect.value = state.travelPersonaId;
      return;
    }
    state.travelPersonaId = els.roomSelect.value;
    await refreshTravelPersonaView().catch((error) => {
      setSyncStatus(`ペルソナのAI設定・利用額を更新できません: ${error.message}`, "warn");
    });
    return;
  }
  saveComposerDraft();
  state.roomId = els.roomSelect.value;
  localStorage.setItem("nexusLite.roomId", state.roomId);
  state.managementLoaded = false;
  state.historyLimit = 12;
  restoreComposerDraft();
  await loadPrimaryRoomData();
  refreshLetterbox();
  refreshConnectionExtras().catch((error) => setSyncStatus(`補助情報の取得に失敗しました: ${error.message}`, "warn"));
});
els.travelProfileSelect.addEventListener("change", () => {
  els.travelRouteStatus.textContent = "選択はまだ適用されていません。";
  loadTravelModels(els.travelProfileSelect.value).catch(() => {
    els.travelModelStatus.textContent =
      "モデル一覧を取得できません。現在使用中のAIは変更していません。";
  });
});
els.travelModelSelect.addEventListener("change", () => {
  els.travelRouteStatus.textContent = "選択はまだ適用されていません。";
  setTravelRouteControls();
});
els.travelModelRefreshButton.addEventListener("click", () => {
  loadTravelModels(els.travelProfileSelect.value, true).catch(() => {
    els.travelModelStatus.textContent =
      "モデル一覧を更新できません。現在使用中のAIは変更していません。";
  });
});
els.travelRouteApplyButton.addEventListener("click", () => {
  applyTravelRouteChange().catch(() => {
    els.travelRouteStatus.textContent =
      "AIの変更を確認できませんでした。現在のAIを維持します。";
    state.travelRouteChanging = false;
    setTravelRouteControls();
  });
});
els.chatForm.addEventListener("submit", sendMessage);
els.voiceButton.addEventListener("click", toggleVoiceRecording);
els.managementDetails.addEventListener("toggle", () => refreshManagement().catch((error) => {
  setManagementStatus("失敗", "error");
  setSyncStatus(`管理情報の取得に失敗しました: ${error.message}`, "warn");
}));
els.managementDetails.addEventListener("toggle", () => refreshLetterbox());
els.letterboxRefreshButton.addEventListener("click", () => refreshLetterbox());
els.draftRefreshButton.addEventListener("click", () => {
  state.managementLoaded = false;
  refreshManagement({ force: true }).catch((error) => setSyncStatus(`Twitter下書きの取得に失敗しました: ${error.message}`, "warn"));
});
els.draftSelect.addEventListener("change", renderSelectedDraft);
els.draftContent.addEventListener("input", () => {
  const draft = selectedDraft();
  if (!draft) {
    return;
  }
  const length = Array.from(els.draftContent.value).length;
  const warningText = draft.warnings?.length ? ` / ${draft.warnings.join(" / ")}` : "";
  els.draftMeta.textContent = `${length}/${draft.limit}${warningText}`;
});
els.draftApproveButton.addEventListener("click", approveSelectedDraft);
els.draftRejectButton.addEventListener("click", rejectSelectedDraft);
els.locationSelect.addEventListener("change", setSelectedLocation);
els.autonomyQuietButton.addEventListener("click", () => setAutonomyPreset("quiet"));
els.autonomyNormalButton.addEventListener("click", () => setAutonomyPreset("normal"));
els.noteRefreshButton.addEventListener("click", loadNoteHeadings);
els.noteTypeSelect.addEventListener("change", loadNoteHeadings);
els.noteShowSectionButton.addEventListener("click", loadNoteSection);
els.noteEditButton.addEventListener("click", startNoteEdit);
els.noteSaveButton.addEventListener("click", saveNoteEdit);
els.noteCancelButton.addEventListener("click", cancelNoteEdit);
els.notificationEnableButton.addEventListener("click", requestNotificationPermission);
els.notificationTestButton.addEventListener("click", testLiteNotification);
els.notificationUnsubscribeCurrentButton.addEventListener("click", unsubscribeCurrentPushDevice);
els.eventNotificationSaveButton.addEventListener("click", saveEventNotificationSettings);
els.closeImageDialog.addEventListener("click", () => els.imageDialog.close());
els.imageDialog.addEventListener("click", (event) => {
  if (event.target === els.imageDialog) {
    els.imageDialog.close();
  }
});
els.messageInput.addEventListener("input", () => {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(140, els.messageInput.scrollHeight)}px`;
  if (state.mode === "travel") travelAdapter.saveDraft(els.messageInput.value);
  else saveComposerDraft();
});
els.itemButton.addEventListener("click", () => openItemDialog());
els.closeItemDialog.addEventListener("click", () => els.itemDialog.close());
els.itemTargetSelect.addEventListener("change", loadItems);
els.itemSelect.addEventListener("change", renderItemPreview);
els.itemActionSelect.addEventListener("change", () => {
  els.itemFurnitureField.hidden = els.itemActionSelect.value !== "place";
});
els.itemRefreshButton.addEventListener("click", loadItems);
els.itemExecuteButton.addEventListener("click", executeItemAction);
els.itemDialog.addEventListener("click", (event) => {
  if (event.target === els.itemDialog) {
    els.itemDialog.close();
  }
});
for (const button of document.querySelectorAll("[data-nav-page]")) {
  button.addEventListener("click", () => setActivePage(button.dataset.navPage));
}
els.imageInput.addEventListener("change", () => {
  const file = els.imageInput.files?.[0];
  els.attachmentName.textContent = file ? `添付: ${file.name}` : "";
});
els.themeSelect.addEventListener("change", () => {
  state.theme = els.themeSelect.value;
  localStorage.setItem("nexusLite.theme", state.theme);
  applyThemeSettings();
});
els.colorSchemeSelect.addEventListener("change", () => {
  state.colorScheme = els.colorSchemeSelect.value;
  localStorage.setItem("nexusLite.colorScheme", state.colorScheme);
  applyThemeSettings();
});
els.redactionEnabledCheckbox.addEventListener("change", () => {
  state.redactionEnabled = els.redactionEnabledCheckbox.checked;
  localStorage.setItem("nexusLite.redactionEnabled", state.redactionEnabled);
  if (els.redactionSummaryStatus) {
    els.redactionSummaryStatus.textContent = state.redactionEnabled ? "有効" : "オフ";
    els.redactionSummaryStatus.className = state.redactionEnabled ? "status-pill ok" : "status-pill";
  }
  renderChatMessages();
});
els.addRuleButton.addEventListener("click", () => {
  const findVal = els.ruleFindInput.value.trim();
  const replaceVal = els.ruleReplaceInput.value.trim();
  const colorVal = els.ruleColorInput.value;

  if (!findVal) {
    alert("元の文字列を入力してください。");
    return;
  }

  const exists = state.redactionRules.some(r => r.find === findVal);
  if (exists) {
    alert("既に同じ検索語のルールが存在します。");
    return;
  }

  state.redactionRules.push({
    find: findVal,
    replace: replaceVal,
    color: colorVal
  });

  localStorage.setItem("nexusLite.redactionRules", JSON.stringify(state.redactionRules));
  els.ruleFindInput.value = "";
  els.ruleReplaceInput.value = "";

  renderRulesList();
  renderChatMessages();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.sending || state.pendingSend)) {
    markPendingResponseNotificationWanted();
  }
  if (!document.hidden && state.connected && state.roomId) {
    syncNow()
      .then(() => maybeAutoRefreshStandby())
      .catch((error) => showConnectionError(error));
  }
});
window.addEventListener("focus", () => {
  if (!document.hidden && state.connected && state.roomId && state.mode === "home") {
    refreshStatus().catch((error) => console.warn("Lite status refresh failed:", error));
  }
});
window.addEventListener("pageshow", () => {
  if (!document.hidden && state.connected && state.roomId && state.mode === "home") {
    refreshStatus().catch((error) => console.warn("Lite status refresh failed:", error));
  }
});
window.setInterval(() => {
  if (!document.hidden && state.connected && state.roomId && state.mode === "home" && !state.sending && !state.syncing) {
    refreshStatus().catch((error) => console.warn("Lite status refresh failed:", error));
  }
}, STATUS_REFRESH_INTERVAL_MS);
window.setInterval(() => {
  renderSnapshotFreshness();
  maybeAutoRefreshStandby().catch((error) => {
    console.warn("Lite standby auto refresh failed:", error);
  });
}, STANDBY_AUTO_CHECK_INTERVAL_MS);
window.setInterval(renderSnapshotFreshness, 60_000);

els.homeModeButton.addEventListener("click", () => handleHomeModeAction().catch((error) => setSyncStatus(error.message, "warn")));
els.travelModeButton.addEventListener("click", () => enterTravelMode().catch((error) => setSyncStatus(error.message, "warn")));
els.returnHomeButton.addEventListener("click", () => returnTravelToHome().catch((error) => setSyncStatus(error.message, "warn")));
els.standbyShortcutButton.addEventListener("click", openStandbySettings);
els.travelPairButton.addEventListener("click", () => pairTravelDevice().catch((error) => setSyncStatus(error.message, "warn")));
els.installAppButton.addEventListener("click", () => installLiteApp().catch((error) => {
  els.installStatus.textContent = `インストール案内を開けませんでした: ${error.message}`;
}));
els.standbyRefreshButton.addEventListener("click", () => prepareStandbyFromLite().catch((error) => {
  els.standbyStatus.textContent = `お出かけ前のデータ: ${error.message}`;
  setConnectivityStep("standby", "prepare_failed", "error", "準備に失敗", error.message);
}));
els.externalAiExportDetails.addEventListener("toggle", () => {
  if (!els.externalAiExportDetails.open) clearExternalAiExport();
});
els.externalAiShowButton.addEventListener("click", () => showExternalAiExport().catch((error) => {
  els.externalAiExportStatus.textContent = error.message;
}));
els.externalAiCopyButton.addEventListener("click", () => copyExternalAiExport().catch((error) => {
  els.externalAiExportStatus.textContent = error.message;
}));
els.externalAiClearButton.addEventListener("click", clearExternalAiExport);
els.connectionNextButton.addEventListener("click", runConnectivityNextAction);
els.connectionCompactButton.addEventListener("click", () => openConnectionSettings());
els.connectionCheckButton.addEventListener("click", async () => {
  els.connectionCheckButton.disabled = true;
  setConnectivityStep("home", "checking", "checking", "確認中", "本体への到達性を確認しています。");
  setConnectivityStep("worker", "checking", "checking", "確認中", "Lite用クラウドへの接続を確認しています。");
  setConnectivityStep("device", "checking", "checking", "確認中", "端末認証を確認しています。");
  setConnectivityStep("standby", "checking", "checking", "確認中", "お出かけ前のデータを確認しています。");
  try {
    await Promise.all([probeHome(), refreshTravelReadiness()]);
  } finally {
    els.connectionCheckButton.disabled = false;
  }
});
const storedStandbyAutoRefresh = localStorage.getItem("nexusLite.standbyAutoRefresh");
els.standbyAutoRefreshCheckbox.checked = storedStandbyAutoRefresh === null || storedStandbyAutoRefresh === "true";
if (storedStandbyAutoRefresh === null) {
  localStorage.setItem("nexusLite.standbyAutoRefresh", "true");
}
els.standbyIncludeCoreMemoryCheckbox.checked = localStorage.getItem("nexusLite.standbyIncludeCoreMemory") !== "false";
els.standbyIncludeEpisodicMemoryCheckbox.checked = localStorage.getItem("nexusLite.standbyIncludeEpisodicMemory") !== "false";
els.standbyEpisodicMemoryDays.value = localStorage.getItem("nexusLite.standbyEpisodicMemoryDays") || "2";
els.standbyRecentMessageLimit.value = localStorage.getItem("nexusLite.standbyRecentMessageLimit") || "40";
applyStandbyDataPreset(localStorage.getItem("nexusLite.standbyDataPreset") || "recommended", { persist: false });
els.standbyDataPreset.addEventListener("change", () => {
  applyStandbyDataPreset(els.standbyDataPreset.value);
});
els.standbyIncludeCoreMemoryCheckbox.addEventListener("change", () => {
  localStorage.setItem("nexusLite.standbyIncludeCoreMemory", String(els.standbyIncludeCoreMemoryCheckbox.checked));
});
els.standbyIncludeEpisodicMemoryCheckbox.addEventListener("change", () => {
  localStorage.setItem("nexusLite.standbyIncludeEpisodicMemory", String(els.standbyIncludeEpisodicMemoryCheckbox.checked));
  els.standbyEpisodicMemoryDays.disabled = !els.standbyIncludeEpisodicMemoryCheckbox.checked;
});
els.standbyEpisodicMemoryDays.addEventListener("change", () => {
  const value = Math.max(0, Math.min(30, Number(els.standbyEpisodicMemoryDays.value) || 0));
  els.standbyEpisodicMemoryDays.value = String(value);
  localStorage.setItem("nexusLite.standbyEpisodicMemoryDays", String(value));
});
els.standbyRecentMessageLimit.addEventListener("change", () => {
  const value = Math.max(0, Math.min(40, Number(els.standbyRecentMessageLimit.value) || 0));
  els.standbyRecentMessageLimit.value = String(value);
  localStorage.setItem("nexusLite.standbyRecentMessageLimit", String(value));
});
els.standbyAutoRefreshCheckbox.addEventListener("change", () => {
  localStorage.setItem("nexusLite.standbyAutoRefresh", String(els.standbyAutoRefreshCheckbox.checked));
  if (els.standbyAutoRefreshCheckbox.checked) {
    maybeAutoRefreshStandby({ forceCheck: true }).catch((error) => {
      els.standbyStatus.textContent = `お出かけ前データの自動更新: ${error.message}`;
    });
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  renderInstallState();
});
window.addEventListener("appinstalled", () => {
  state.deferredInstallPrompt = null;
  renderInstallState();
  renderStorageContext();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
}

updateNotificationStatus();
applyThemeSettings();
applyRedactionSettings();
renderStorageContext();
try {
  state.latestStandbySnapshot = JSON.parse(localStorage.getItem("nexusLite.latestStandbySnapshot") || "null");
} catch {
  state.latestStandbySnapshot = null;
}
renderSnapshotFreshness();
renderInstallState();
setLiteMode("home");
if (isCloudHostedLite() && !travelAdapter.configuredBase()) {
  travelAdapter.configure(window.location.origin);
}
const pairingHandoffConsumed = consumePairingHandoff();
setActivePage(pairingHandoffConsumed ? "settings" : "chat");

async function initializeLiteConnections() {
  // 本体接続とLite用クラウド診断を同時に始めると、再読込直後のAPI要求が集中し、
  // 有効な保存済みTokenでも履歴取得だけ失敗して未接続表示になることがある。
  // チャット復元を先に完了し、その後で独立モード側を確認する。
  let homeResult;
  try {
    if (!state.apiBase) throw new Error("本体URL未設定");
    await connect({ collapse: true, useInputs: false });
    homeResult = { status: "fulfilled" };
  } catch (error) {
    homeResult = { status: "rejected", reason: error };
  }

  const readiness = await refreshTravelReadiness().catch((error) => {
    setSyncStatus(`Lite用クラウドの確認に失敗しました: ${error.message}`, "warn");
    return null;
  });
  const currentTravelSession = readiness?.currentSession || state.currentTravelSession;
  if (currentTravelSession) {
    await enterTravelMode().catch((error) => setSyncStatus(error.message, "warn"));
    return;
  }
  if (homeResult.status === "rejected") {
    state.homeReachable = false;
    setConnectionStatus("本体へ接続できません", "warn");
    setSyncStatus("お出かけ前のデータがあれば、独立モードを明示開始できます。", "warn");
    setConnectivityStep("home", "connection_error", "error", "接続エラー", "API URL、接続用Token、本体の起動状態を確認してください。");
  } else if (els.standbyAutoRefreshCheckbox.checked) {
    maybeAutoRefreshStandby({ forceCheck: true }).catch((error) => {
      els.standbyStatus.textContent = `お出かけ前データの自動更新: ${error.message}`;
    });
  }
}

initializeLiteConnections();
