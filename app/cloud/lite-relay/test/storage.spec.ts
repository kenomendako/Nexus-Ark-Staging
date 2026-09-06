import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  commitCompletedMessage,
  createTravelSession,
  deleteSessionContent,
  getEventsAfterCursor,
  getMessageRequest,
  markProviderStarted,
  recoverAmbiguousRequests,
  reserveMessage,
  type CommitMessageInput,
} from "../src/storage";
import { estimateUsageCost } from "../src/pricing-catalog";

const USAGE = {
  input_tokens: 10,
  output_tokens: 3,
  cache_read_tokens: 6,
  cache_creation_tokens: 0,
  reasoning_tokens: null,
  provider_reported_cost_usd: null,
  usage_status: "reported" as const,
};

async function prepareRequest(suffix: string): Promise<{ sessionId: string; clientId: string }> {
  const sessionId = `session-${suffix}`;
  const clientId = `client-${suffix}`;
  await createTravelSession(env.DB, {
    travelSessionId: sessionId,
    retentionDays: 7,
    createdAt: "2026-07-15T00:00:00Z",
  });
  await reserveMessage(env.DB, {
    clientMessageId: clientId,
    travelSessionId: sessionId,
    personaId: "persona-phase0",
    provider: "openai",
    modelRequested: "model-phase0",
    reservedAt: "2026-07-15T00:00:01Z",
  });
  expect(await markProviderStarted(env.DB, clientId, "2026-07-15T00:00:02Z")).toBe(true);
  return { sessionId, clientId };
}

function commitInput(sessionId: string, clientId: string, suffix: string, sequenceNo = 1): CommitMessageInput {
  return {
    clientMessageId: clientId,
    eventId: `event-${suffix}`,
    receiptId: `receipt-${suffix}`,
    travelSessionId: sessionId,
    personaId: "persona-phase0",
    sequenceNo,
    createdAt: "2026-07-15T00:00:03Z",
    content: "PHASE0_OK",
    contentHash: `hash-${suffix}`,
    provider: "openai",
    gateway: null,
    credentialProfileId: "profile-phase0",
    modelRequested: "model-phase0",
    modelResolved: "model-phase0",
    upstreamProvider: null,
    usage: USAGE,
    pricing: estimateUsageCost("openai", "model-phase0", USAGE),
    signature: `signature-${suffix}`,
  };
}

describe("D1 idempotency and retention contracts", () => {
  it("同じclient_message_idの並行予約は1件だけprovider呼出権を得る", async () => {
    await createTravelSession(env.DB, {
      travelSessionId: "session-reserve",
      retentionDays: 7,
      createdAt: "2026-07-15T00:00:00Z",
    });
    const input = {
      clientMessageId: "client-reserve",
      travelSessionId: "session-reserve",
      personaId: "persona-phase0",
      provider: "openai" as const,
      modelRequested: "model-phase0",
      reservedAt: "2026-07-15T00:00:01Z",
    };
    const results = await Promise.all([reserveMessage(env.DB, input), reserveMessage(env.DB, input)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.request.status === "reserved")).toBe(true);
  });

  it("event、receipt、requestを一つのbatchで確定する", async () => {
    const { sessionId, clientId } = await prepareRequest("commit");
    await commitCompletedMessage(env.DB, commitInput(sessionId, clientId, "commit"));

    expect((await getMessageRequest(env.DB, clientId))?.status).toBe("completed");
    const page = await getEventsAfterCursor(env.DB, sessionId, "persona-phase0", 0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.content).toBe("PHASE0_OK");
    const receipt = await env.DB
      .prepare("SELECT receipt_id FROM usage_receipts WHERE event_id = ?")
      .bind("event-commit")
      .first<{ receipt_id: string }>();
    expect(receipt?.receipt_id).toBe("receipt-commit");
  });

  it("batch途中のreceipt制約違反でeventもrollbackする", async () => {
    const first = await prepareRequest("atomic-first");
    await commitCompletedMessage(env.DB, commitInput(first.sessionId, first.clientId, "atomic-shared"));

    const second = await prepareRequest("atomic-second");
    const badInput = commitInput(second.sessionId, second.clientId, "atomic-second");
    badInput.receiptId = "receipt-atomic-shared";
    await expect(commitCompletedMessage(env.DB, badInput)).rejects.toThrow();

    const event = await env.DB
      .prepare("SELECT event_id FROM travel_events WHERE event_id = ?")
      .bind("event-atomic-second")
      .first();
    expect(event).toBeNull();
    expect((await getMessageRequest(env.DB, second.clientId))?.status).toBe("provider_started");
  });

  it("cursor差分と欠番を報告する", async () => {
    const first = await prepareRequest("cursor-1");
    await commitCompletedMessage(env.DB, commitInput(first.sessionId, first.clientId, "cursor-1", 1));

    await reserveMessage(env.DB, {
      clientMessageId: "client-cursor-3",
      travelSessionId: first.sessionId,
      personaId: "persona-phase0",
      provider: "openai",
      modelRequested: "model-phase0",
      reservedAt: "2026-07-15T00:00:04Z",
    });
    await markProviderStarted(env.DB, "client-cursor-3", "2026-07-15T00:00:05Z");
    await commitCompletedMessage(env.DB, commitInput(first.sessionId, "client-cursor-3", "cursor-3", 3));

    const page = await getEventsAfterCursor(env.DB, first.sessionId, "persona-phase0", 0);
    expect(page.events.map((event) => event.sequence_no)).toEqual([1, 3]);
    expect(page.missing_sequences).toEqual([2]);
    expect(page.next_cursor).toBe(3);
  });

  it("本文削除は冪等でreceiptとcontent_hashを残す", async () => {
    const { sessionId, clientId } = await prepareRequest("delete");
    await commitCompletedMessage(env.DB, commitInput(sessionId, clientId, "delete"));
    await deleteSessionContent(env.DB, sessionId, "2026-07-16T00:00:00Z");
    await deleteSessionContent(env.DB, sessionId, "2026-07-17T00:00:00Z");

    const event = (await getEventsAfterCursor(env.DB, sessionId, "persona-phase0", 0)).events[0];
    expect(event?.content).toBeNull();
    expect(event?.content_hash).toBe("hash-delete");
    expect(event?.content_deleted_at).toBe("2026-07-16T00:00:00Z");
    const receipt = await env.DB
      .prepare("SELECT receipt_id FROM usage_receipts WHERE travel_session_id = ?")
      .bind(sessionId)
      .first();
    expect(receipt).not.toBeNull();
  });

  it("provider開始後に放置された予約をoutcome_unknownへ回収する", async () => {
    const { clientId } = await prepareRequest("unknown");
    const changed = await recoverAmbiguousRequests(
      env.DB,
      "2026-07-15T00:01:00Z",
      "2026-07-15T00:02:00Z",
    );
    expect(changed).toBeGreaterThanOrEqual(1);
    expect((await getMessageRequest(env.DB, clientId))?.status).toBe("outcome_unknown");
  });

  it("retention 0でclose済みのsessionへ遅延commitしない", async () => {
    const sessionId = `session-closed-${crypto.randomUUID()}`;
    const clientId = `client-closed-${crypto.randomUUID()}`;
    await createTravelSession(env.DB, {
      travelSessionId: sessionId,
      retentionDays: 0,
      createdAt: "2026-07-15T00:00:00Z",
    });
    await reserveMessage(env.DB, {
      clientMessageId: clientId,
      travelSessionId: sessionId,
      personaId: "persona-phase0",
      provider: "openai",
      modelRequested: "model-phase0",
      reservedAt: "2026-07-15T00:00:01Z",
    });
    await markProviderStarted(env.DB, clientId, "2026-07-15T00:00:02Z");
    await env.DB.prepare("UPDATE travel_sessions SET status = 'closed' WHERE travel_session_id = ?")
      .bind(sessionId).run();

    await expect(commitCompletedMessage(env.DB, commitInput(sessionId, clientId, crypto.randomUUID())))
      .rejects.toThrow(/travel_session_not_active/);
    expect((await getEventsAfterCursor(env.DB, sessionId, "persona-phase0", 0)).events).toHaveLength(0);
    expect((await getMessageRequest(env.DB, clientId))?.status).toBe("provider_started");
  });
});
