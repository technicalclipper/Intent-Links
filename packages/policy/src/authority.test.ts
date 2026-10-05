import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, policyHash, sha256, targetHash } from "./hash.js";
import {
  MemoryTokenStore,
  issueToken,
  verifyAndSpend,
  type SpendIntent,
} from "./token.js";
import {
  GENESIS_HASH,
  appendEntry,
  entryForDecision,
  summarize,
  verifyChain,
  type AuditEntry,
} from "./audit.js";
import { Policy } from "@intentlink/schema";

/* ------------------------------ canonicalize ------------------------------ */

test("canonicalization is key-order independent", () => {
  const a = { b: 1, a: { d: 2, c: [3, 4] } };
  const b = { a: { c: [3, 4], d: 2 }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(sha256(canonicalize(a)), sha256(canonicalize(b)));
});

test("array order is preserved, because rule precedence depends on it", () => {
  assert.notEqual(canonicalize({ r: [1, 2] }), canonicalize({ r: [2, 1] }));
});

test("hashing a policy that already carries a hash is stable", () => {
  const p = Policy.parse({
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  const h = policyHash(p);
  assert.equal(policyHash(Policy.parse({ ...p, hash: h })), h);
});

test("changing a single rule changes the policy hash", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
  const a = Policy.parse(base);
  const b = Policy.parse({
    ...base,
    allowed: [{ id: "x", verb: "create_channel", args: [], boundSteps: [] }],
  });
  assert.notEqual(policyHash(a), policyHash(b));
});

/* --------------------------------- tokens --------------------------------- */

const SECRET = "test-secret-not-a-real-one";
const SAVE_TARGET = targetHash({ role: "button", name: "Save" });
const DELETE_TARGET = targetHash({ role: "button", name: "Delete workspace" });

const binding = {
  executionId: "33333333-3333-4333-8333-333333333333",
  stepId: "s1",
  verb: "set_setting",
  targetHash: SAVE_TARGET,
};
const intent = (over: Partial<SpendIntent> = {}): SpendIntent => ({ ...binding, ...over });

test("a freshly issued token verifies and spends once", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken(SECRET, binding);
  const first = await verifyAndSpend(SECRET, token, intent(), store);
  assert.equal(first.ok, true);
});

test("a token cannot be replayed", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken(SECRET, binding);
  assert.equal((await verifyAndSpend(SECRET, token, intent(), store)).ok, true);
  const replay = await verifyAndSpend(SECRET, token, intent(), store);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, "already_spent");
});

test("a token for Save cannot be spent on Delete", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken(SECRET, binding);
  const misuse = await verifyAndSpend(
    SECRET,
    token,
    intent({ targetHash: DELETE_TARGET }),
    store,
  );
  assert.equal(misuse.ok, false);
  assert.equal(misuse.ok === false && misuse.reason, "wrong_target");
});

test("a rejected token is NOT consumed, so a near-miss cannot burn authority", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken(SECRET, binding);

  const wrongTarget = await verifyAndSpend(
    SECRET,
    token,
    intent({ targetHash: DELETE_TARGET }),
    store,
  );
  assert.equal(wrongTarget.ok, false);

  // The legitimate spend must still work.
  const proper = await verifyAndSpend(SECRET, token, intent(), store);
  assert.equal(proper.ok, true);
});

test("binding covers execution, step and verb as well as target", async () => {
  const store = new MemoryTokenStore();
  const cases: Array<[Partial<SpendIntent>, string]> = [
    [{ executionId: "44444444-4444-4444-8444-444444444444" }, "wrong_execution"],
    [{ stepId: "s2" }, "wrong_step"],
    [{ verb: "delete_channel" }, "wrong_verb"],
  ];
  for (const [over, reason] of cases) {
    const { token } = issueToken(SECRET, binding);
    const r = await verifyAndSpend(SECRET, token, intent(over), store);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, reason);
  }
});

test("the extension cannot mint a token", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken("some-other-secret", binding);
  const r = await verifyAndSpend(SECRET, token, intent(), store);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "bad_signature");
});

test("a tampered payload fails the signature, not the parse", async () => {
  const store = new MemoryTokenStore();
  const { token } = issueToken(SECRET, binding);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...binding, jti: "x", iat: 0, exp: 9999999999, verb: "delete_channel" }),
    "utf8",
  ).toString("base64url");
  assert.notEqual(forged, payload);
  const r = await verifyAndSpend(SECRET, `${forged}.${sig}`, intent(), store);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "bad_signature");
});

test("an expired token is refused", async () => {
  const store = new MemoryTokenStore();
  const issuedAt = new Date("2026-10-05T10:00:00.000Z");
  const { token } = issueToken(SECRET, binding, { ttlSeconds: 30, now: issuedAt });
  const r = await verifyAndSpend(
    SECRET,
    token,
    intent(),
    store,
    new Date("2026-10-05T10:00:31.000Z"),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "expired");
});

test("malformed input is refused rather than throwing", async () => {
  const store = new MemoryTokenStore();
  for (const bad of ["", ".", "nodot", "a.", ".b"]) {
    const r = await verifyAndSpend(SECRET, bad, intent(), store);
    assert.equal(r.ok, false);
  }
});

/* ------------------------------- audit chain ------------------------------ */

const chainOf = (kinds: Array<Parameters<typeof appendEntry>[1]>): AuditEntry[] => {
  const out: AuditEntry[] = [];
  let tail: AuditEntry | undefined;
  for (const input of kinds) {
    tail = appendEntry(tail, input);
    out.push(tail);
  }
  return out;
};

test("the genesis entry links to the zero hash", () => {
  const e = appendEntry(undefined, {
    kind: "execution_started",
    executionId: "e1",
    at: "2026-10-05T10:00:00.000Z",
  });
  assert.equal(e.seq, 0);
  assert.equal(e.prevHash, GENESIS_HASH);
  assert.equal(e.hash.length, 64);
});

test("a well-formed chain verifies", () => {
  const entries = chainOf([
    { kind: "execution_started", executionId: "e1", at: "2026-10-05T10:00:00.000Z" },
    { kind: "step_started", executionId: "e1", at: "2026-10-05T10:00:01.000Z", stepId: "s1" },
    { kind: "action_executed", executionId: "e1", at: "2026-10-05T10:00:02.000Z", stepId: "s1", verb: "create_channel" },
  ]);
  assert.deepEqual(verifyChain(entries), { ok: true, length: 3 });
});

test("altering an entry breaks the chain at that entry", () => {
  const entries = chainOf([
    { kind: "execution_started", executionId: "e1", at: "2026-10-05T10:00:00.000Z" },
    { kind: "action_blocked", executionId: "e1", at: "2026-10-05T10:00:02.000Z", stepId: "s1", verb: "delete_channel" },
    { kind: "execution_finished", executionId: "e1", at: "2026-10-05T10:00:03.000Z" },
  ]);
  // Rewrite history: pretend the block never happened.
  entries[1] = { ...entries[1]!, kind: "action_executed" };
  const verdict = verifyChain(entries);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.brokenAt, 1);
  assert.equal(verdict.ok === false && verdict.why, "hash");
});

test("removing an entry breaks the chain", () => {
  const entries = chainOf([
    { kind: "execution_started", executionId: "e1", at: "2026-10-05T10:00:00.000Z" },
    { kind: "action_blocked", executionId: "e1", at: "2026-10-05T10:00:01.000Z", stepId: "s1", verb: "delete_channel" },
    { kind: "execution_finished", executionId: "e1", at: "2026-10-05T10:00:02.000Z" },
  ]);
  const withHole = [entries[0]!, entries[2]!];
  const verdict = verifyChain(withHole);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.brokenAt, 1);
});

test("a decision becomes the right kind of entry and keeps the creator's words", () => {
  const blocked = entryForDecision(
    undefined,
    "2026-10-05T10:00:05.000Z",
    "e1",
    "s4",
    { verb: "invite_user", resource: "https://acme.slack.com/admin/channels" },
    {
      outcome: "DENY",
      ruleId: "d1",
      sourceText: "don't invite anyone outside the company",
      reason: 'Blocked by your boundary: "don\'t invite anyone outside the company"',
    },
  );
  assert.equal(blocked.kind, "action_blocked");
  assert.equal(blocked.sourceText, "don't invite anyone outside the company");

  const approval = entryForDecision(
    blocked,
    "2026-10-05T10:00:06.000Z",
    "e1",
    "s5",
    { verb: "send_page" },
    { outcome: "APPROVAL", reason: "needs approval" },
  );
  assert.equal(approval.kind, "approval_requested");
  assert.equal(approval.prevHash, blocked.hash);
});

test("the summary is the tally the side panel shows live", () => {
  const entries = chainOf([
    { kind: "execution_started", executionId: "e1", at: "t0" },
    { kind: "action_executed", executionId: "e1", at: "t1", verb: "create_channel" },
    { kind: "action_executed", executionId: "e1", at: "t2", verb: "set_topic" },
    { kind: "action_blocked", executionId: "e1", at: "t3", verb: "invite_user", sourceText: "don't invite anyone outside the company" },
    { kind: "action_blocked", executionId: "e1", at: "t4", verb: "invite_user", sourceText: "don't invite anyone outside the company" },
    { kind: "approval_granted", executionId: "e1", at: "t5", verb: "send_page" },
    { kind: "assertion_checked", executionId: "e1", at: "t6", assertionPassed: true },
    { kind: "assertion_checked", executionId: "e1", at: "t7", assertionPassed: false },
  ]);
  const s = summarize(entries);
  assert.equal(s.allowed, 2);
  assert.equal(s.blocked, 2);
  assert.equal(s.approvals, 1);
  assert.equal(s.assertionsPassed, 1);
  assert.equal(s.assertionsFailed, 1);
  assert.deepEqual(s.boundariesHit, ["don't invite anyone outside the company"]);
});
