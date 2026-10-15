import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChain } from "@intentlink/policy";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileStore, MemoryStore } from "./store.js";

/**
 * These test the CONTRACT, not the memory implementation, so the Firestore
 * one can be checked against the same expectations once a project exists.
 */

test("a policy round-trips", async () => {
  const store = new MemoryStore();
  const policy = {
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    scope: { origins: [], paths: [], resources: [], dataExclusions: [] },
    allowed: [],
    denied: [],
    approvalRequired: [],
    limits: { numeric: [], maxActions: 200, maxExecutions: 1, rateLimit: 60, maxNavigationHops: 5 },
    timeWindows: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
    receivers: [],
    destructiveVerbs: [],
    allowTypedLiterals: true,
    mode: "live" as const,
  };
  await store.putPolicy(policy);
  assert.equal((await store.getPolicy(policy.id))?.id, policy.id);
  assert.equal(await store.getPolicy("nope"), undefined);
});

test("the pinned hash is what a later run is judged against", async () => {
  const store = new MemoryStore();
  await store.pin("e1", "a".repeat(64));
  assert.equal(await store.getPin("e1"), "a".repeat(64));
  assert.equal(await store.getPin("e2"), undefined);
});

test("the store owns appending, so the chain cannot fork", async () => {
  const store = new MemoryStore();
  // Appended concurrently and on purpose: the caller never sees the tail, so
  // two requests cannot both build on a stale one.
  await Promise.all(
    ["a", "b", "c", "d", "e"].map((id) =>
      store.append("e1", { kind: "action_executed", executionId: "e1", at: id, verb: id }),
    ),
  );

  const log = await store.getAudit("e1");
  assert.equal(log.length, 5);
  assert.deepEqual(verifyChain(log), { ok: true, length: 5 });
  assert.deepEqual(
    log.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

test("counters give the engine a rolling window, not a running total", async () => {
  const store = new MemoryStore();
  const t0 = 1_700_000_000_000;

  await store.countAction("e1", t0);
  await store.countAction("e1", t0 + 1_000);
  const soon = await store.countAction("e1", t0 + 2_000);
  assert.equal(soon.actionsUsed, 3);
  assert.equal(soon.actionsInLastMinute, 3);

  // Two minutes later the earlier ones have aged out of the window but still
  // count against the per-run ceiling.
  const later = await store.getCounters("e1", t0 + 120_000);
  assert.equal(later.actionsUsed, 3);
  assert.equal(later.actionsInLastMinute, 0);
});

test("executions do not see each other's counters", async () => {
  const store = new MemoryStore();
  await store.countAction("e1", 1);
  assert.equal((await store.getCounters("e2", 1)).actionsUsed, 0);
});

test("a token is spendable once, and a rejection does not burn it", async () => {
  const store = new MemoryStore();
  assert.equal(await store.tokens.consume("jti-1", 9999999999, 1), true);
  assert.equal(await store.tokens.consume("jti-1", 9999999999, 1), false);
  assert.equal(await store.tokens.consume("jti-2", 9999999999, 1), true);
});

test("published links survive a restart", async () => {
  // The API runs under --watch, so every build restarts it. With a purely
  // in-memory store a published link stopped existing mid-run and the
  // receiver got "policy service refused the request (404)" with no hint
  // that the cause was a file save.
  const path = `${tmpdir()}/intentlink-store-${randomUUID()}.json`;
  const policy = {
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    scope: { origins: [], paths: [], resources: [], dataExclusions: [] },
    allowed: [], denied: [], approvalRequired: [],
    limits: { numeric: [], maxActions: 200, maxExecutions: 1, rateLimit: 60, maxNavigationHops: 5 },
    timeWindows: [], expiresAt: "2099-01-01T00:00:00.000Z",
    receivers: [], destructiveVerbs: [], allowTypedLiterals: true, mode: "live" as const,
  };

  try {
    const first = await FileStore.open(path);
    await first.putPolicy(policy);
    await first.pin("exec-1", "a".repeat(64));
    // Writes are serialised behind a promise chain; let it settle.
    await new Promise((r) => setTimeout(r, 50));

    const second = await FileStore.open(path);
    assert.equal((await second.getPolicy(policy.id))?.id, policy.id);
    assert.equal(await second.getPin("exec-1"), "a".repeat(64));
  } finally {
    await rm(path, { force: true });
  }
});

test("an unreadable store file starts empty rather than refusing to boot", async () => {
  const path = `${tmpdir()}/intentlink-bad-${randomUUID()}.json`;
  await writeFile(path, "{ not json", "utf8");
  try {
    const store = await FileStore.open(path);
    assert.equal(await store.getPolicy("anything"), undefined);
  } finally {
    await rm(path, { force: true });
  }
});
