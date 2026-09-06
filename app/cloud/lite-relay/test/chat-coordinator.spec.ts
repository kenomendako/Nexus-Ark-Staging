import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { normalizeProviderStream } from "../src/adapters";
import { coordinateMessage } from "../src/chat-coordinator";
import { createTravelSession, getMessageRequest, type CommitMessageInput } from "../src/storage";
import type { NormalizedStream } from "../src/types";
import { estimateUsageCost } from "../src/pricing-catalog";
import { MockProvider } from "./mock-provider";

function buildCommit(sessionId: string, clientId: string, stream: NormalizedStream): CommitMessageInput {
  return {
    clientMessageId: clientId,
    eventId: `event-${clientId}`,
    receiptId: `receipt-${clientId}`,
    travelSessionId: sessionId,
    personaId: "persona-phase0",
    sequenceNo: 1,
    createdAt: "2026-07-15T00:00:03Z",
    content: stream.text,
    contentHash: `hash-${clientId}`,
    provider: stream.provider,
    gateway: stream.provider === "openrouter" ? "openrouter" : null,
    credentialProfileId: "profile-phase0",
    modelRequested: stream.model_requested,
    modelResolved: stream.model_resolved,
    upstreamProvider: stream.upstream_provider,
    usage: stream.usage,
    pricing: estimateUsageCost(stream.provider, stream.model_resolved || stream.model_requested, stream.usage),
    signature: `signature-${clientId}`,
  };
}

describe("chat coordinator", () => {
  it("同じclient_message_idの再送でproviderを二度呼ばない", async () => {
    const sessionId = "session-coordinator";
    const clientId = "client-coordinator";
    await createTravelSession(env.DB, {
      travelSessionId: sessionId,
      retentionDays: 7,
      createdAt: "2026-07-15T00:00:00Z",
    });
    const mock = new MockProvider();
    const common = {
      db: env.DB,
      reservation: {
        clientMessageId: clientId,
        travelSessionId: sessionId,
        personaId: "persona-phase0",
        provider: "openai" as const,
        modelRequested: "model-phase0",
        reservedAt: "2026-07-15T00:00:01Z",
      },
      providerStartedAt: "2026-07-15T00:00:02Z",
      finalizedAt: "2026-07-15T00:00:03Z",
      invoke: async () => normalizeProviderStream("openai", await mock.stream("openai"), "model-phase0"),
      buildCommit: (stream: NormalizedStream) => buildCommit(sessionId, clientId, stream),
    };

    expect(await coordinateMessage(common)).toEqual({ invoked: true, status: "completed" });
    expect(await coordinateMessage(common)).toEqual({ invoked: false, status: "completed" });
    expect(mock.calls).toBe(1);
  });

  it("provider開始後の例外はoutcome_unknownとして自動再送を止める", async () => {
    const sessionId = "session-ambiguous";
    const clientId = "client-ambiguous";
    await createTravelSession(env.DB, {
      travelSessionId: sessionId,
      retentionDays: 7,
      createdAt: "2026-07-15T00:00:00Z",
    });
    let calls = 0;
    const common = {
      db: env.DB,
      reservation: {
        clientMessageId: clientId,
        travelSessionId: sessionId,
        personaId: "persona-phase0",
        provider: "anthropic" as const,
        modelRequested: "model-phase0",
        reservedAt: "2026-07-15T00:00:01Z",
      },
      providerStartedAt: "2026-07-15T00:00:02Z",
      finalizedAt: "2026-07-15T00:00:03Z",
      invoke: async (): Promise<NormalizedStream> => {
        calls += 1;
        throw new Error("synthetic_provider_disconnect");
      },
      buildCommit: (stream: NormalizedStream) => buildCommit(sessionId, clientId, stream),
    };

    expect(await coordinateMessage(common)).toEqual({ invoked: true, status: "outcome_unknown" });
    expect(await coordinateMessage(common)).toEqual({ invoked: false, status: "outcome_unknown" });
    expect(calls).toBe(1);
    expect((await getMessageRequest(env.DB, clientId))?.status).toBe("outcome_unknown");
  });
});
