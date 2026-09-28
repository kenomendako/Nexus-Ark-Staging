const KEYS = {
  base: "nexusLite.travel.apiBase",
  access: "nexusLite.travel.device.accessToken",
  refresh: "nexusLite.travel.device.refreshToken",
  deviceId: "nexusLite.travel.device.id",
  sessionId: "nexusLite.travel.sessionId",
  personaId: "nexusLite.travel.personaId",
  draft: "nexusLite.travel.draft",
  pending: "nexusLite.travel.pendingMessage",
  pendingArchive: "nexusLite.travel.pendingArchive",
};
const SUPPORTED_API_SCHEMA_VERSION = 10;
const REQUIRED_D1_SCHEMA_VERSION = 10;
const FINAL_PENDING_STATUSES = new Set(["completed", "partial", "failed_known"]);

function inspectPendingMessage() {
  const raw = localStorage.getItem(KEYS.pending);
  if (raw === null) return { state: "none", pending: null, raw: null };
  try {
    const pending = JSON.parse(raw);
    if (!pending || typeof pending !== "object" || Array.isArray(pending) || typeof pending.client_message_id !== "string" || !pending.client_message_id) {
      return { state: "corrupt", pending: null, raw };
    }
    return { state: "pending", pending, raw };
  } catch {
    return { state: "corrupt", pending: null, raw };
  }
}

function safeBrowserError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 40),
    message: String(error?.message || "").replace(/[\r\n]+/g, " ").slice(0, 160),
  };
}

export class TravelAdapterError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = "TravelAdapterError";
    this.code = code;
    this.status = status;
  }
}

function normalizeWorkerUrl(workerUrl) {
  const parsed = new URL(workerUrl);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("Worker URLはHTTPSで指定してください。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Worker URLに認証情報・クエリ・fragmentは指定できません。");
  return parsed.href.replace(/\/+$/, "");
}

function base() {
  return (localStorage.getItem(KEYS.base) || "").replace(/\/+$/, "");
}

function accessToken() {
  return localStorage.getItem(KEYS.access) || "";
}

function saveCredentials(value) {
  localStorage.setItem(KEYS.access, value.access_token);
  localStorage.setItem(KEYS.refresh, value.refresh_token);
  localStorage.setItem(KEYS.deviceId, value.device_id);
}

function clearCredentials() {
  [KEYS.access, KEYS.refresh, KEYS.deviceId].forEach((key) => localStorage.removeItem(key));
}

let refreshAccessInFlight = null;
let pendingOperationInFlight = false;
let connectionRevision = 0;

function connectionContext() { return { base: base(), revision: connectionRevision }; }
function assertConnection(context) {
  if (context.base !== base() || context.revision !== connectionRevision) {
    throw new TravelAdapterError("接続先が変更されました。元の接続先と記録を確認してください。", "pending_origin_mismatch");
  }
}
async function withPendingGuard(operation) {
  const busy = () => new TravelAdapterError("別のLite送信確認を処理中です。少し待って再確認してください。", "pending_send_unresolved");
  if (pendingOperationInFlight) throw busy();
  pendingOperationInFlight = true;
  try {
    if (globalThis.navigator?.locks?.request) {
      return await navigator.locks.request("nexusLite.travel.pending", { ifAvailable: true }, (lock) => {
        if (!lock) throw busy();
        return operation();
      });
    }
    return await operation();
  } finally {
    pendingOperationInFlight = false;
  }
}

function listPendingArchive() {
  const raw = localStorage.getItem(KEYS.pendingArchive);
  if (raw === null) return [];
  try {
    const records = JSON.parse(raw);
    if (!Array.isArray(records) || records.some((item) =>
      !item || typeof item.raw !== "string" || typeof item.review_id !== "string"
      || typeof item.reviewed_at !== "string" || !["unknown", "home_recovered"].includes(item.mode)
      || typeof item.worker_url !== "string")) throw new Error();
    return records;
  } catch {
    throw new TravelAdapterError("保管した記録を読み取れないため、元の送信記録を保持しています。", "pending_archive_corrupt");
  }
}

function assertPendingRaw(raw) {
  if (localStorage.getItem(KEYS.pending) !== raw) {
    throw new TravelAdapterError("送信記録が変わりました。状態を再確認してください。", "pending_changed");
  }
}

function pendingIdentityMatches(body, pending) {
  return body?.client_message_id === pending.client_message_id
    && (!pending.session_id || body.travel_session_id === pending.session_id)
    && (!pending.persona_id || body.persona_id === pending.persona_id);
}

async function inspectRemotePending(inspected, context) {
  const pending = inspected.pending;
  if (pending.worker_url && pending.worker_url !== context.base) {
    throw new TravelAdapterError("保存済みの送信は別の接続先で開始されています。元の接続先へ戻してください。", "pending_origin_mismatch");
  }
  const body = await jsonRequest("/v1/message-requests/" + encodeURIComponent(pending.client_message_id));
  assertConnection(context);
  assertPendingRaw(inspected.raw);
  if (!pendingIdentityMatches(body, pending)) {
    throw new TravelAdapterError("送信記録の照合に失敗しました。元の記録を保持しています。", "pending_identity_mismatch");
  }
  return body;
}

async function pendingStatusInternal() {
  const inspected = inspectPendingMessage();
  if (inspected.state === "none") return null;
  if (inspected.state === "corrupt") {
    throw new TravelAdapterError("前回のLite送信状態を読み取れません。元の記録を保持しています。", "pending_send_unresolved");
  }
  const context = connectionContext();
  const body = await inspectRemotePending(inspected, context);
  assertConnection(context);
  assertPendingRaw(inspected.raw);
  if (FINAL_PENDING_STATUSES.has(body.status)) {
    localStorage.removeItem(KEYS.pending);
    return null;
  }
  return body;
}

async function archivePendingInternal(expectedRaw, { mode, confirmed } = {}) {
  if (confirmed !== true || !["unknown", "home_recovered"].includes(mode)) {
    throw new TravelAdapterError("記録を保管する前に確認が必要です。", "pending_confirmation_required");
  }
  if (typeof expectedRaw !== "string") {
    throw new TravelAdapterError("保管する送信記録がありません。", "pending_changed");
  }
  assertPendingRaw(expectedRaw);
  const inspected = inspectPendingMessage();
  const context = connectionContext();
  if (mode === "unknown") {
    const pending = inspected.pending;
    if (!pending?.worker_url || !pending.session_id || !pending.persona_id) {
      throw new TravelAdapterError("元の送信先を確実に照合できません。本体側で状態を確認してください。", "pending_identity_mismatch");
    }
    const body = await inspectRemotePending(inspected, context);
    if (body.status !== "outcome_unknown") {
      throw new TravelAdapterError("結果不明として保管できる状態ではありません。再確認してください。", "pending_send_unresolved");
    }
  }
  assertConnection(context);
  assertPendingRaw(expectedRaw);
  const archive = listPendingArchive();
  if (!archive.some((item) => item.raw === expectedRaw)) {
    if (archive.length >= 100) {
      throw new TravelAdapterError("保管記録が上限の100件に達しています。元の送信記録は保持しています。", "pending_archive_full");
    }
    archive.push({ review_id: crypto.randomUUID(), reviewed_at: new Date().toISOString(),
      mode, worker_url: inspected.pending?.worker_url || context.base, raw: expectedRaw });
    try {
      localStorage.setItem(KEYS.pendingArchive, JSON.stringify(archive));
    } catch {
      throw new TravelAdapterError("記録を保管できません。端末の空き容量を確認してください。元の送信記録は保持しています。", "pending_archive_failed");
    }
  }
  assertConnection(context);
  assertPendingRaw(expectedRaw);
  localStorage.removeItem(KEYS.pending);
}


async function performRefreshAccess() {
  const context = connectionContext();
  const refreshToken = localStorage.getItem(KEYS.refresh);
  if (!refreshToken || !base()) return { ok: false, reason: "credentials_missing" };
  let response;
  try {
    response = await fetch(`${base()}/v1/devices/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, reason: "worker_unreachable", error };
  }
  assertConnection(context);
  if (localStorage.getItem(KEYS.refresh) !== refreshToken) throw new TravelAdapterError("端末登録が変わりました。状態を再確認してください。", "pending_changed");
  if (response.status === 401 || response.status === 403) {
    clearCredentials();
    return { ok: false, reason: "re_pair_required", status: response.status };
  }
  if (!response.ok) return { ok: false, reason: "refresh_failed", status: response.status };
  const credentials = await response.json();
  assertConnection(context);
  if (localStorage.getItem(KEYS.refresh) !== refreshToken) throw new TravelAdapterError("端末登録が変わりました。状態を再確認してください。", "pending_changed");
  saveCredentials(credentials);
  return { ok: true };
}

function refreshAccess() {
  if (!refreshAccessInFlight) {
    refreshAccessInFlight = performRefreshAccess().finally(() => {
      refreshAccessInFlight = null;
    });
  }
  return refreshAccessInFlight;
}

async function request(path, options = {}, retry = true, classifyUnauthorized = true, context = connectionContext()) {
  assertConnection(context);
  if (!base()) throw new Error("Worker URLが未設定です。");
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (accessToken()) headers.set("Authorization", `Bearer ${accessToken()}`);
  let response;
  try {
    response = await fetch(`${base()}${path}`, { ...options, headers, cache: "no-store" });
  } catch (error) {
    throw new TravelAdapterError("Workerへ接続できません。", "worker_unreachable");
  }
  assertConnection(context);
  if (response.status === 401 && retry && classifyUnauthorized) {
    const refreshed = await refreshAccess();
    assertConnection(context);
    if (refreshed.ok) return request(path, options, false, classifyUnauthorized, context);
    if (refreshed.reason === "worker_unreachable") {
      throw new TravelAdapterError("Workerへ接続できないため端末認証を更新できません。", "worker_unreachable");
    }
    if (refreshed.reason === "refresh_failed") {
      throw new TravelAdapterError(
        "端末認証を更新できません。Workerの状態を確認して再試行してください。",
        "refresh_failed",
        refreshed.status,
      );
    }
    clearCredentials();
    throw new TravelAdapterError(
      "端末の認証期限が切れているか、端末が失効されています。再ペアリングが必要です。",
      "re_pair_required",
      refreshed.status || 401,
    );
  }
  if (response.status === 401 && classifyUnauthorized) {
    clearCredentials();
    throw new TravelAdapterError(
      "端末の認証期限が切れているか、端末が失効されています。再ペアリングが必要です。",
      "re_pair_required",
      401,
    );
  }
  return response;
}

async function jsonRequest(path, options = {}, classifyUnauthorized = true) {
  const context = connectionContext();
  const response = await request(path, options, classifyUnauthorized, classifyUnauthorized, context);
  const body = await response.json().catch(() => ({}));
  assertConnection(context);
  if (!response.ok) {
    const code = typeof body?.error === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(body.error)
      ? body.error
      : "worker_request_failed";
    throw new TravelAdapterError(code, code, response.status);
  }
  return body;
}

function parseSse(text) {
  let answer = "";
  let terminal = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "response.text.delta") answer += event.text || "";
      if (["response.committed", "response.partial", "response.error"].includes(event.type)) terminal = event.type;
    } catch {
      // 未知イベントは表示せず、確定照会可能なpendingを維持する。
    }
  }
  return { answer, terminal };
}

export const travelAdapter = {
  keys: KEYS,
  configure(workerUrl) {
    const nextBase = normalizeWorkerUrl(workerUrl);
    const currentBase = base();
    if (currentBase !== nextBase) {
      connectionRevision += 1;
      clearCredentials();
      localStorage.removeItem(KEYS.sessionId);
      localStorage.removeItem(KEYS.personaId);
    }
    localStorage.setItem(KEYS.base, nextBase);
  },
  configuredBase: base,
  inspectPending: inspectPendingMessage,
  listPendingArchive,
  archivePending: (raw, options) => withPendingGuard(() => archivePendingInternal(raw, options)),
  paired: () => Boolean(accessToken()),
  errorCode: (error) => error instanceof TravelAdapterError ? error.code : "",
  async health() {
    if (!base()) return { ok: false, error: "worker_url_missing" };
    let response;
    try {
      response = await fetch(`${base()}/v1/health`, { cache: "no-store" });
    } catch (error) {
      const primaryError = safeBrowserError(error);
      try {
        await fetch(`${base()}/v1/health`, { cache: "no-store", mode: "no-cors" });
        return {
          ok: false,
          error: "cors_rejected",
          browser_error: primaryError.name,
          browser_message: primaryError.message,
        };
      } catch (fallbackError) {
        const fallback = safeBrowserError(fallbackError);
        return {
          ok: false,
          error: "worker_unreachable",
          browser_error: primaryError.name,
          browser_message: primaryError.message,
          fallback_error: fallback.name,
          fallback_message: fallback.message,
        };
      }
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      const parsed = safeBrowserError(error);
      return {
        ok: false,
        error: "worker_invalid_response",
        http_status: response.status,
        content_type: response.headers.get("content-type") || "",
        browser_error: parsed.name,
        browser_message: parsed.message,
      };
    }
    if (!response.ok || !Number.isInteger(body.api_schema_version)) {
      return {
        ok: false,
        error: "worker_invalid_response",
        http_status: response.status,
        content_type: response.headers.get("content-type") || "",
        api_schema_version: body.api_schema_version,
      };
    }
    if (body.api_schema_version > SUPPORTED_API_SCHEMA_VERSION) {
      return { ok: false, error: "pwa_update_required", api_schema_version: body.api_schema_version };
    }
    if (body.api_schema_version < SUPPORTED_API_SCHEMA_VERSION) {
      return { ok: false, error: "worker_update_required", api_schema_version: body.api_schema_version };
    }
    if (
      body.storage_schema_ready === false
      || (Number.isInteger(body.d1_schema_version) && body.d1_schema_version < REQUIRED_D1_SCHEMA_VERSION)
    ) {
      return {
        ok: false,
        error: "worker_update_required",
        api_schema_version: body.api_schema_version,
        d1_schema_version: body.d1_schema_version,
        storage_schema_ready: body.storage_schema_ready,
      };
    }
    return body;
  },
  async pair(code, displayName) {
    const body = await jsonRequest("/v1/devices/pair", {
      method: "POST",
      body: JSON.stringify({ code, display_name: displayName }),
    }, false);
    saveCredentials(body);
    return body;
  },
  listStandby: () => jsonRequest("/v1/standby-snapshots"),
  externalAiExportFromStandby(standbySnapshotId, personaId) {
    return jsonRequest(`/v1/standby-snapshots/${encodeURIComponent(standbySnapshotId)}/external-ai-export`, {
      method: "POST",
      body: JSON.stringify({
        persona_id: personaId,
        disclosure_confirmed: true,
        include_core_memory: true,
        include_episodic_summary: true,
        recent_message_limit: 40,
      }),
    });
  },
  externalAiExportFromSession(sessionId, personaId) {
    return jsonRequest(
      `/v1/travel-sessions/${encodeURIComponent(sessionId)}/personas/${encodeURIComponent(personaId)}/external-ai-export`,
      {
        method: "POST",
        body: JSON.stringify({
          disclosure_confirmed: true,
          include_core_memory: true,
          include_episodic_summary: true,
          recent_message_limit: 40,
        }),
      },
    );
  },
  async activate(standbySnapshotId, activationMode) {
    const activationId = crypto.randomUUID();
    const body = await jsonRequest(`/v1/standby-snapshots/${encodeURIComponent(standbySnapshotId)}/activate`, {
      method: "POST",
      body: JSON.stringify({ activation_id: activationId, activation_mode: activationMode }),
    });
    localStorage.setItem(KEYS.sessionId, body.activated_session_id || "");
    return body;
  },
  async currentSession() {
    const body = await jsonRequest("/v1/travel-sessions/current");
    const session = body.session || null;
    if (session?.travel_session_id) localStorage.setItem(KEYS.sessionId, session.travel_session_id);
    return session;
  },
  async events(session, personaId) {
    const path = Array.isArray(session.personas)
      ? `/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/personas/${encodeURIComponent(personaId)}/events`
      : `/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/events`;
    return jsonRequest(`${path}?after_sequence=0`);
  },
  providerProfiles: () => jsonRequest("/v1/provider-profiles"),
  models(credentialProfileId, refresh = false) {
    const suffix = refresh ? "?refresh=1" : "";
    return jsonRequest(
      `/v1/provider-profiles/${encodeURIComponent(credentialProfileId)}/models${suffix}`,
    );
  },
  async changeRoute(session, personaId, credentialProfileId, modelId) {
    const path = Array.isArray(session.personas)
      ? `/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/personas/${encodeURIComponent(personaId)}/route`
      : `/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/route`;
    return jsonRequest(path, {
      method: "PUT",
      body: JSON.stringify({
        route_change_id: crypto.randomUUID().replaceAll("-", "_"),
        credential_profile_id: credentialProfileId,
        model_id: modelId,
      }),
    });
  },
  usageSummary(session, personaId) {
    const query = Array.isArray(session.personas) && personaId
      ? `?persona_id=${encodeURIComponent(personaId)}`
      : "";
    return jsonRequest(
      `/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/usage-summary${query}`,
    );
  },
  async send(session, personaId, message, clientMessageId) {
    return withPendingGuard(async () => {
      const context = connectionContext();
      const pendingStatus = await pendingStatusInternal();
      assertConnection(context);
      if (pendingStatus) {
        throw new TravelAdapterError("前回のLite送信結果が未確定です。状態を確認してください。", "pending_send_unresolved");
      }
      assertPendingRaw(null);
      const pending = {
        client_message_id: clientMessageId,
        session_id: session.travel_session_id,
        persona_id: personaId,
        message,
        worker_url: base(),
        device_id: localStorage.getItem(KEYS.deviceId) || "",
        created_at: new Date().toISOString(),
      };
      const pendingRaw = JSON.stringify(pending);
      localStorage.setItem(KEYS.pending, pendingRaw);
      const response = await request("/v1/travel-sessions/" + encodeURIComponent(session.travel_session_id) + "/messages", {
        method: "POST",
        body: JSON.stringify({ client_message_id: clientMessageId, persona_id: personaId, message }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Worker " + response.status);
      }
      const result = parseSse(await response.text());
      assertConnection(context);
      if (result.terminal === "response.committed") {
        assertPendingRaw(pendingRaw);
        localStorage.removeItem(KEYS.pending);
      }
      return result;
    });
  },
  pendingStatus: () => withPendingGuard(pendingStatusInternal),
  saveDraft(value) { localStorage.setItem(KEYS.draft, value); },
  draft: () => localStorage.getItem(KEYS.draft) || "",
  clear() {
    Object.values(KEYS).filter((key) => key !== KEYS.base && key !== KEYS.pendingArchive).forEach((key) => localStorage.removeItem(key));
  },
};
