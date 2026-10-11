import assert from "node:assert/strict";

import {
  createAsrSessionTicket,
  verifyAsrSessionTicket
} from "../shared/asr-session-ticket.mjs";

const env = { ASR_SESSION_SECRET:"test-only-session-secret" };
const claims = {
  sessionId:"round-1",
  userId:"user-1",
  provider:"tencent-realtime-v2",
  questionIds:["q1", "q2", "q1"]
};

const ticket = await createAsrSessionTicket(env, claims, 60_000);
const verified = await verifyAsrSessionTicket(env, ticket, {
  sessionId:"round-1",
  provider:"tencent-realtime-v2",
  questionId:"q2"
});

assert.equal(verified?.sessionId, "round-1");
assert.equal(verified?.userId, "user-1");
assert.deepEqual(verified?.questionIds, ["q1", "q2"]);
assert.equal(await verifyAsrSessionTicket(env, ticket, { sessionId:"round-2" }), null);
assert.equal(await verifyAsrSessionTicket(env, ticket, { provider:"baidu-realtime" }), null);
assert.equal(await verifyAsrSessionTicket(env, ticket, { questionId:"q3" }), null);

const [encoded, signature] = ticket.split(".");
const replacement = encoded.endsWith("a") ? "b" : "a";
const tampered = `${encoded.slice(0, -1)}${replacement}.${signature}`;
assert.equal(await verifyAsrSessionTicket(env, tampered), null);

const expired = await createAsrSessionTicket(env, claims, -1);
assert.equal(await verifyAsrSessionTicket(env, expired), null);
assert.equal(await verifyAsrSessionTicket(env, ""), null);
await assert.rejects(
  () => createAsrSessionTicket({}, claims),
  /缺少 ASR 会话签名密钥/
);

console.log("ASR session ticket tests passed.");
