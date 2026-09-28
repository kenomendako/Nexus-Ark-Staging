import { describe, expect, it } from "vitest";

import {
  assertAllowedProviderUrl,
  assertNoCanary,
  fetchProviderWithoutRedirect,
  resolveSecret,
  sanitizeCapture,
} from "../src/security";

describe("provider security boundary", () => {
  it("公式HTTPS hostだけを許可する", () => {
    expect(assertAllowedProviderUrl("openai", "https://api.openai.com/v1/responses").hostname).toBe("api.openai.com");
    expect(() => assertAllowedProviderUrl("openai", "http://api.openai.com/v1/responses")).toThrow(
      "provider_url_not_allowed",
    );
    expect(() => assertAllowedProviderUrl("openai", "https://api.openai.com.example.test/v1/responses")).toThrow(
      "provider_url_not_allowed",
    );
    expect(() => assertAllowedProviderUrl("openai", "https://api.openai.com:8443/v1/responses")).toThrow(
      "provider_url_not_allowed",
    );
    expect(() => assertAllowedProviderUrl("openai", "https://user:pass@api.openai.com/v1/responses")).toThrow(
      "provider_url_not_allowed",
    );
  });

  it("静的allowlistにあるSecret bindingだけを解決する", () => {
    const env = {
      APP_MODE: "must-not-be-readable-as-secret",
      OPENAI_PERSONAL_1: "PHASE0_SECRET_CANARY",
      OPENAI_PERSONAL_2: "PHASE0_SECRET_CANARY_2",
    } as Env;
    expect(resolveSecret("OPENAI_PERSONAL_1", env)).toBe("PHASE0_SECRET_CANARY");
    expect(resolveSecret("OPENAI_PERSONAL_2", env)).toBe("PHASE0_SECRET_CANARY_2");
    expect(() => resolveSecret("GEMINI_PERSONAL_1", env)).toThrow("secret_binding_unavailable");
    expect(() => resolveSecret("APP_MODE", env)).toThrow("secret_binding_not_allowed");
  });

  it("captureからheader、query、canaryを除去する", () => {
    const canary = "PHASE0_SECRET_CANARY";
    const sanitized = sanitizeCapture(
      {
        headers: { Authorization: `Bearer ${canary}`, "x-api-key": canary },
        url: `https://generativelanguage.googleapis.com/v1/models?key=${canary}`,
        usage: { input_tokens: 12, output_tokens: 3 },
        nested: { text: `safe-${canary}` },
      },
      [canary],
    );
    expect(() => assertNoCanary(sanitized, [canary])).not.toThrow();
    expect(JSON.stringify(sanitized)).toContain("[REDACTED]");
    expect(sanitized).toMatchObject({ usage: { input_tokens: 12, output_tokens: 3 } });
  });

  it("認証付きredirectを追従しない", async () => {
    let redirectMode: RequestRedirect | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { Location: "https://evil.test" } });
    }) as typeof fetch;
    await expect(
      fetchProviderWithoutRedirect(
        "openai",
        "https://api.openai.com/v1/responses",
        { headers: { Authorization: "Bearer PHASE0_SECRET_CANARY" } },
        fetcher,
      ),
    ).rejects.toThrow("provider_redirect_rejected");
    expect(redirectMode).toBe("manual");
  });
});
