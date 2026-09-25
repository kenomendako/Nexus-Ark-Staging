import assert from "node:assert/strict";
import test from "node:test";

import { parsePairingHandoff } from "../../../mobile_app/static/pairing-handoff.js";

const now = Date.parse("2026-07-17T12:00:00Z");
const expires = "2026-07-17T12:05:00Z";
const code = "pairing_code_123456";

test("HTTPS fragmentからWorker originと短期コードだけを取り込む", () => {
  const value = parsePairingHandoff(
    `https://relay.example.test/#nexus-lite-pairing=${code}&expires=${encodeURIComponent(expires)}`,
    now,
  );

  assert.deepEqual(value, {
    present: true,
    valid: true,
    workerUrl: "https://relay.example.test",
    code,
    expiresAt: expires,
    cleanUrl: "/",
  });
});

test("期限切れfragmentは値を渡さずURL清掃対象にする", () => {
  const value = parsePairingHandoff(
    `https://relay.example.test/#nexus-lite-pairing=${code}&expires=2026-07-17T11%3A59%3A00Z`,
    now,
  );

  assert.equal(value.present, true);
  assert.equal(value.valid, false);
  assert.equal(value.reason, "expired");
  assert.equal(value.code, undefined);
  assert.equal(value.cleanUrl, "/");
});

test("通常のhashはペアリング情報として扱わない", () => {
  assert.deepEqual(parsePairingHandoff("https://relay.example.test/#settings", now), { present: false });
});

test("remote HTTP originは拒否する", () => {
  const value = parsePairingHandoff(
    `http://relay.example.test/#nexus-lite-pairing=${code}&expires=${encodeURIComponent(expires)}`,
    now,
  );

  assert.equal(value.valid, false);
  assert.equal(value.reason, "insecure_origin");
});
