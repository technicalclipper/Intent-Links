import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Policy } from "@intentlink/schema";
import { MemoryStore, createApp } from "./server.js";

const SECRET = "x".repeat(48);

const fixturePolicy = Policy.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../packages/schema/fixtures/policy.incident-channel.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** A clock the tests control, so expiry and rate limits are deterministic. */
const NOW = new Date("2026-10-05T10:00:00.000Z");

async function withServer(
  fn: (base: string) => Promise<void>,
  clock: () => Date = () => NOW,
): Promise<void> {
  const server = createApp(new MemoryStore(), SECRET, clock);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const EXEC = "33333333-3333-4333-8333-333333333333";

const action = (over: Record<string, unknown> = {}) => ({
  executionId: EXEC,
  stepId: "s1",
  verb: "create_channel",
  object: "channel",
  args: {},
  origin: "https://acme.slack.com",
  path: "/admin/channels",
  ...over,
});

/** Register the policy and start an execution pinned to its hash. */
async function bootstrap(base: string): Promise<string> {
  const stored = await put(base, "/v1/policies", fixturePolicy);
  assert.equal(stored.status, 200);
  const { hash } = (await stored.json()) as { hash: string };

  const started = await post(base, "/v1/executions", {
    executionId: EXEC,
    policyId: fixturePolicy.id,
  });
  assert.equal(started.status, 200);
  return hash;
}

test("healthz answers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test("the service computes the policy hash itself and never trusts the client", async () => {
  await withServer(async (base) => {
    const res = await put(base, "/v1/policies", { ...fixturePolicy, hash: "f".repeat(64) });
    assert.equal(res.status, 200);
    const { hash } = (await res.json()) as { hash: string };
    assert.notEqual(hash, "f".repeat(64));
    assert.equal(hash.length, 64);
  });
});

test("an invalid policy is refused", async () => {
  await withServer(async (base) => {
    const res = await put(base, "/v1/policies", { id: "not-a-uuid" });
    assert.equal(res.status, 400);
  });
});

test("decide allows a permitted action and issues a bound token", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const res = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ targetHash: "a".repeat(64) }),
    });
    assert.equal(res.status, 200);
    const decision = (await res.json()) as { outcome: string; token?: string };
    assert.equal(decision.outcome, "ALLOW");
    assert.ok(decision.token, "an ALLOW must carry a token");
  });
});

test("decide blocks and returns the creator's sentence, with no token", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const res = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ verb: "invite_user", object: undefined, args: { email: "x@other.com" } }),
    });
    const decision = (await res.json()) as { outcome: string; token?: string; sourceText?: string };
    assert.equal(decision.outcome, "DENY");
    assert.equal(decision.token, undefined);
    assert.equal(decision.sourceText, "don't invite anyone outside the company");
  });
});

test("preview returns the same verdict but never a token", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const res = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      preview: true,
      action: action(),
    });
    const decision = (await res.json()) as { outcome: string; token?: string };
    assert.equal(decision.outcome, "ALLOW");
    assert.equal(decision.token, undefined);
  });
});

test("the extension cannot act without redeeming, and cannot redeem twice", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const decided = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ targetHash: "a".repeat(64) }),
    });
    const { token } = (await decided.json()) as { token: string };

    const intent = {
      token,
      executionId: EXEC,
      stepId: "s1",
      verb: "create_channel",
      targetHash: "a".repeat(64),
    };

    const first = await post(base, "/v1/redeem", intent);
    assert.equal(first.status, 200);

    const replay = await post(base, "/v1/redeem", intent);
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { reason: string }).reason, "already_spent");
  });
});

test("a token cannot be redirected to a different target", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const decided = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ targetHash: "a".repeat(64) }),
    });
    const { token } = (await decided.json()) as { token: string };

    const res = await post(base, "/v1/redeem", {
      token,
      executionId: EXEC,
      stepId: "s1",
      verb: "create_channel",
      targetHash: "b".repeat(64),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { reason: string }).reason, "wrong_target");
  });
});

test("a forged token is refused", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const res = await post(base, "/v1/redeem", {
      token: "bm90LWEtcmVhbC1wYXlsb2Fk.bm90LWEtcmVhbC1zaWc",
      executionId: EXEC,
      stepId: "s1",
      verb: "create_channel",
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { reason: string }).reason, "bad_signature");
  });
});

test("the audit log records the block as well as the success, and the chain verifies", async () => {
  await withServer(async (base) => {
    await bootstrap(base);

    await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ targetHash: "a".repeat(64) }),
    });
    await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      receiver: "platform@acme.com",
      action: action({ verb: "invite_user", object: undefined, args: { email: "x@other.com" } }),
    });

    const res = await fetch(`${base}/v1/audit/${EXEC}`);
    const body = (await res.json()) as {
      entries: Array<{ kind: string; sourceText?: string }>;
      summary: { blocked: number; boundariesHit: string[] };
      chain: { ok: boolean };
    };

    assert.equal(body.chain.ok, true, "the hash chain must verify end to end");
    assert.equal(body.entries[0]?.kind, "execution_started");
    assert.ok(body.entries.some((e) => e.kind === "action_blocked"));
    assert.equal(body.summary.blocked, 1);
    assert.deepEqual(body.summary.boundariesHit, ["don't invite anyone outside the company"]);
  });
});

test("an unknown policy is a 404, not a silent allow", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/decide", {
      policyId: "99999999-9999-4999-8999-999999999999",
      action: action(),
    });
    assert.equal(res.status, 404);
  });
});

test("a malformed action is rejected rather than evaluated", async () => {
  await withServer(async (base) => {
    await bootstrap(base);
    const res = await post(base, "/v1/decide", {
      policyId: fixturePolicy.id,
      action: { verb: "create_channel" },
    });
    assert.equal(res.status, 400);
  });
});
