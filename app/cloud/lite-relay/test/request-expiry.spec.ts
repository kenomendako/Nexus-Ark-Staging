import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from "cloudflare:test";
import worker from "../src/index";
import { REQUEST_EXPIRY_CRON } from "../src/request-deadline";
import { describe, expect, it } from "vitest";
import {
  commitCompletedMessage, commitConversationTurn, createTravelSession, getMessageRequest,
  markProviderStarted, recoverAmbiguousRequests, recoverStaleRequests, reserveMessage, type CommitMessageInput,
} from "../src/storage";
import { estimateUsageCost } from "../src/pricing-catalog";

async function started(suffix: string) {
  const sessionId = "expiry-session-" + suffix;
  const clientId = "expiry-client-" + suffix;
  await createTravelSession(env.DB, {travelSessionId: sessionId, retentionDays: 7, createdAt: "2026-09-14T00:00:00.000Z"});
  await reserveMessage(env.DB, {clientMessageId: clientId, travelSessionId: sessionId, personaId: "persona",
    provider: "openai", modelRequested: "model-phase0", reservedAt: "2026-09-14T00:00:00.000Z"});
  await markProviderStarted(env.DB, clientId, "2026-09-14T00:00:01.000Z");
  await env.DB.prepare("UPDATE message_requests SET budget_reserved_usd = 0.1, budget_state = 'reserved' WHERE client_message_id = ?")
    .bind(clientId).run();
  return {sessionId, clientId};
}
function commitInput(sessionId: string, clientId: string): CommitMessageInput {
  const usage = {input_tokens: 10, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0,
    reasoning_tokens: null, provider_reported_cost_usd: null, usage_status: "reported" as const};
  return {clientMessageId: clientId, travelSessionId: sessionId, personaId: "persona",
    eventId: "event-" + clientId, receiptId: "receipt-" + clientId, sequenceNo: 1,
    createdAt: "2026-09-14T00:01:00.000Z", content: "synthetic", contentHash: "synthetic-hash",
    provider: "openai", gateway: null, credentialProfileId: "synthetic-profile", modelRequested: "model-phase0",
    modelResolved: "model-phase0", upstreamProvider: null, usage, pricing: estimateUsageCost("openai","model-phase0",usage),
    signature: "synthetic-signature"};
}
async function rowCounts(sessionId: string) {
  const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM travel_events WHERE travel_session_id = ?").bind(sessionId).first<{n: number}>();
  const receipts = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_receipts WHERE travel_session_id = ?").bind(sessionId).first<{n: number}>();
  return [events!.n, receipts!.n];
}

describe("request expiry atomic boundary", () => {
  for (const turn of [false, true]) {
    it("事前SELECT後の期限回収が遅延確定を止める: " + (turn ? "会話turn" : "単独message"), async () => {
      const {sessionId,clientId} = await started("race-" + turn);
      let intercepted = false;
      const db = new Proxy(env.DB, {get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          intercepted = true;
          await recoverAmbiguousRequests(env.DB,"2026-09-14T01:00:00.000Z","2026-09-14T01:01:00.000Z");
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
      const input = commitInput(sessionId,clientId);
      const operation = turn ? commitConversationTurn(db, {...input, userEventId:"user-"+clientId,
        userSequenceNo:1,assistantSequenceNo:2,userContent:"synthetic-user",userContentHash:"synthetic-user-hash"})
        : commitCompletedMessage(db,input);
      await expect(operation).rejects.toThrow("message_request_not_committable");
      expect(intercepted).toBe(true);
      expect(await rowCounts(sessionId)).toEqual([0,0]);
      const row = await getMessageRequest(env.DB,clientId);
      expect(row?.status).toBe("outcome_unknown");
      expect(row?.budget_reserved_usd).toBe(0.1);
    });
  }
});

describe("stale request recovery", () => {
  it("開始時刻から30分の境界で回収し、予約額を保持する", async () => {
    const {clientId} = await started("boundary");
    expect(await recoverStaleRequests(env.DB, "2026-09-14T00:30:00.999Z")).toBe(0);
    expect((await getMessageRequest(env.DB, clientId))?.status).toBe("provider_started");
    expect(await recoverStaleRequests(env.DB, "2026-09-14T00:30:01.000Z")).toBe(1);
    expect(await getMessageRequest(env.DB, clientId)).toMatchObject({
      status: "outcome_unknown", budget_state: "held", budget_reserved_usd: 0.1,
      budget_settled_usd: null, finalized_at: "2026-09-14T00:30:01.000Z",
    });
    expect(await recoverStaleRequests(env.DB, "2026-09-15T00:30:01.000Z")).toBe(0);
  });

  it("provider未開始の予約は0精算して開始権を失効させる", async () => {
    const {clientId} = await started("unstarted");
    await env.DB.prepare("UPDATE message_requests SET status = 'reserved', provider_started_at = NULL WHERE client_message_id = ?").bind(clientId).run();
    expect(await recoverStaleRequests(env.DB, "2026-09-14T00:30:00.000Z")).toBe(1);
    expect(await getMessageRequest(env.DB, clientId)).toMatchObject({
      status: "failed_known", budget_state: "released", budget_settled_usd: 0,
    });
    expect(await markProviderStarted(env.DB, clientId, "2026-09-14T00:31:00.000Z")).toBe(false);
  });

  it("未知料金許可の開始済み要求を0精算にせず、完了済み要求を変更しない", async () => {
    const unknown = await started("unknown");
    const completed = await started("completed");
    await env.DB.prepare("UPDATE message_requests SET budget_state = 'unknown_allowed', budget_reserved_usd = 0 WHERE client_message_id = ?").bind(unknown.clientId).run();
    await commitCompletedMessage(env.DB, commitInput(completed.sessionId, completed.clientId));
    const before = await getMessageRequest(env.DB, completed.clientId);
    expect(await recoverStaleRequests(env.DB, "2026-09-14T01:00:00.000Z")).toBe(1);
    expect(await getMessageRequest(env.DB, unknown.clientId)).toMatchObject({
      status: "outcome_unknown", budget_state: "unknown_allowed", budget_settled_usd: null,
    });
    expect(await getMessageRequest(env.DB, completed.clientId)).toEqual(before);
    await expect(recoverStaleRequests(env.DB, "invalid")).rejects.toThrow("invalid_request_expiry_time");
  });
});

describe("scheduled recovery", () => {
  for (const cron of [REQUEST_EXPIRY_CRON, "17 3 * * *"]) {
    it(cron + "が期限回収を実行し、本文保持期限の掃除は日次だけ実行する", async () => {
      const {clientId} = await started("cron-" + cron);
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({cron}), env, ctx);
      await waitOnExecutionContext(ctx);
      expect((await getMessageRequest(env.DB, clientId))?.status).toBe("outcome_unknown");
      const runs = await env.DB.prepare("SELECT status FROM maintenance_runs").all<{status: string}>();
      expect(runs.results.map((run) => run.status)).toEqual(cron === REQUEST_EXPIRY_CRON ? [] : ["completed"]);
    });
  }
});
