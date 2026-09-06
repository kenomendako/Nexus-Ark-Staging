import type { Provider } from "./types";

const PROVIDER_HOSTS: Record<Provider, string> = {
  gemini: "generativelanguage.googleapis.com",
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  xai: "api.x.ai",
  openrouter: "openrouter.ai",
};

export type SecretBindingId =
  | "GEMINI_PERSONAL_1"
  | "OPENAI_PERSONAL_1"
  | "OPENAI_PERSONAL_2"
  | "ANTHROPIC_PERSONAL_1"
  | "XAI_PERSONAL_1"
  | "OPENROUTER_PERSONAL_1";

export function assertAllowedProviderUrl(provider: Provider, value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== PROVIDER_HOSTS[provider] ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  ) {
    throw new Error("provider_url_not_allowed");
  }
  return url;
}

export async function fetchProviderWithoutRedirect(
  provider: Provider,
  value: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = assertAllowedProviderUrl(provider, value);
  const response = await fetcher(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("provider_redirect_rejected");
  }
  return response;
}

const SECRET_BINDING_METADATA: Record<SecretBindingId, { provider: Provider; allowedBaseUrlId: string }> = {
  GEMINI_PERSONAL_1: { provider: "gemini", allowedBaseUrlId: "gemini-official" },
  OPENAI_PERSONAL_1: { provider: "openai", allowedBaseUrlId: "openai-official" },
  OPENAI_PERSONAL_2: { provider: "openai", allowedBaseUrlId: "openai-official" },
  ANTHROPIC_PERSONAL_1: { provider: "anthropic", allowedBaseUrlId: "anthropic-official" },
  XAI_PERSONAL_1: { provider: "xai", allowedBaseUrlId: "xai-official" },
  OPENROUTER_PERSONAL_1: { provider: "openrouter", allowedBaseUrlId: "openrouter-official" },
};

const ALLOWED_SECRET_BINDINGS = new Set<SecretBindingId>(
  Object.keys(SECRET_BINDING_METADATA) as SecretBindingId[],
);

export function secretBindingMetadata(binding: string): { provider: Provider; allowedBaseUrlId: string } {
  if (!ALLOWED_SECRET_BINDINGS.has(binding as SecretBindingId)) {
    throw new Error("secret_binding_not_allowed");
  }
  return SECRET_BINDING_METADATA[binding as SecretBindingId];
}

export function resolveSecret(binding: string, env: Env): string {
  if (!ALLOWED_SECRET_BINDINGS.has(binding as SecretBindingId)) {
    throw new Error("secret_binding_not_allowed");
  }
  const value = env[binding as SecretBindingId];
  if (!value) {
    throw new Error("secret_binding_unavailable");
  }
  return value;
}

const SENSITIVE_KEY =
  /(authorization|x-api-key|api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|bearer[-_]?token)/i;

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || key.toLowerCase() === "key") {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeCapture(value: unknown, canarySecrets: string[] = []): unknown {
  function visit(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map(visit);
    }
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : visit(item);
      }
      return output;
    }
    if (typeof input === "string") {
      let output = scrubUrl(input);
      for (const canary of canarySecrets) {
        if (canary) {
          output = output.split(canary).join("[REDACTED]");
        }
      }
      return output;
    }
    return input;
  }
  return visit(value);
}

export function assertNoCanary(value: unknown, canarySecrets: string[]): void {
  const serialized = JSON.stringify(value);
  if (canarySecrets.some((canary) => canary && serialized.includes(canary))) {
    throw new Error("secret_canary_detected");
  }
}
