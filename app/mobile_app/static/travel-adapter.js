const KEYS = {
  base: "nexusLite.travel.apiBase",
  access: "nexusLite.travel.device.accessToken",
  refresh: "nexusLite.travel.device.refreshToken",
  deviceId: "nexusLite.travel.device.id",
  sessionId: "nexusLite.travel.sessionId",
  personaId: "nexusLite.travel.personaId",
  draft: "nexusLite.travel.draft",
  pending: "nexusLite.travel.pendingMessage",
};
const SUPPORTED_API_SCHEMA_VERSION = 10;
const REQUIRED_D1_SCHEMA_VERSION = 10;

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

async function performRefreshAccess() {
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
  if (response.status === 401 || response.status === 403) {
    clearCredentials();
    return { ok: false, reason: "re_pair_required", status: response.status };
  }
  if (!response.ok) return { ok: false, reason: "refresh_failed", status: response.status };
  saveCredentials(await response.json());
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

async function request(path, options = {}, retry = true, classifyUnauthorized = true) {
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
  if (response.status === 401 && retry && classifyUnauthorized) {
    const refreshed = await refreshAccess();
    if (refreshed.ok) return request(path, options, false, classifyUnauthorized);
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
  const response = await request(path, options, classifyUnauthorized, classifyUnauthorized);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Worker ${response.status}`);
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
    const parsed = new URL(workerUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("Worker URLはHTTPSで指定してください。");
    }
    localStorage.setItem(KEYS.base, parsed.href.replace(/\/+$/, ""));
  },
  configuredBase: base,
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
    const pending = { client_message_id: clientMessageId, session_id: session.travel_session_id, persona_id: personaId, message };
    localStorage.setItem(KEYS.pending, JSON.stringify(pending));
    const response = await request(`/v1/travel-sessions/${encodeURIComponent(session.travel_session_id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ client_message_id: clientMessageId, persona_id: personaId, message }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Worker ${response.status}`);
    }
    const result = parseSse(await response.text());
    if (result.terminal === "response.committed") localStorage.removeItem(KEYS.pending);
    return result;
  },
  async pendingStatus() {
    const pending = JSON.parse(localStorage.getItem(KEYS.pending) || "null");
    if (!pending?.client_message_id) return null;
    return jsonRequest(`/v1/message-requests/${encodeURIComponent(pending.client_message_id)}`);
  },
  saveDraft(value) { localStorage.setItem(KEYS.draft, value); },
  draft: () => localStorage.getItem(KEYS.draft) || "",
  clear() {
    Object.values(KEYS).filter((key) => key !== KEYS.base).forEach((key) => localStorage.removeItem(key));
  },
};
