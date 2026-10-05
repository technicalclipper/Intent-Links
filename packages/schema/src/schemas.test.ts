import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Trace } from "./trace.js";
import { IntentLink } from "./intent.js";
import { Policy, DEFAULT_DESTRUCTIVE_VERBS, ProposedAction } from "./policy.js";

const fixture = (n: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8"));

test("parses the cross-app trace fixture", () => {
  const t = Trace.parse(fixture("trace.slack-jira.json"));
  assert.ok(t.events.length > 0);
  assert.deepEqual(t.apps, ["slack", "jira"]);
});

test("trace fixture contains no coordinates anywhere", () => {
  const raw = readFileSync(
    new URL("../fixtures/trace.slack-jira.json", import.meta.url),
    "utf8",
  );
  for (const banned of ["xpath", "selector", "clientX", "pageY", "boundingRect"]) {
    assert.ok(!raw.includes(banned), `fixture leaked "${banned}"`);
  }
});

test("parses the IntentLink fixture and keeps actions tool-agnostic", () => {
  const i = IntentLink.parse(fixture("intent.incident-channel.json"));
  for (const step of i.steps) {
    assert.ok(
      /^[a-z][a-z0-9_]*$/.test(step.action.verb),
      `verb "${step.action.verb}" must be a semantic verb, not a tool name`,
    );
    assert.ok(!step.action.verb.includes("."), "verbs must not be namespaced tool calls");
  }
});

test("IntentLink args reference declared parameters only", () => {
  const i = IntentLink.parse(fixture("intent.incident-channel.json"));
  const declared = new Set(i.params.map((p) => p.name));
  for (const step of i.steps) {
    for (const [, v] of Object.entries(step.action.args)) {
      if ("param" in v) {
        assert.ok(declared.has(v.param), `undeclared parameter "${v.param}"`);
      }
    }
  }
});

test("parses the policy fixture", () => {
  const p = Policy.parse(fixture("policy.incident-channel.json"));
  assert.equal(p.mode, "live");
  assert.ok(p.denied.length > 0);
});

test("policy defaults are safe when omitted", () => {
  const p = Policy.parse({
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    expiresAt: new Date().toISOString(),
  });
  assert.equal(p.limits.maxExecutions, 1, "single run unless widened");
  assert.equal(p.mode, "live");
  assert.deepEqual(p.allowed, [], "nothing is allowed by default");
});

test("destructive verb list covers the obvious irreversible actions", () => {
  for (const v of ["delete", "revoke", "transfer", "send", "grant_role"]) {
    assert.ok(
      (DEFAULT_DESTRUCTIVE_VERBS as readonly string[]).includes(v),
      `"${v}" must be destructive by default`,
    );
  }
});

test("ProposedAction carries the target hash the token will bind to", () => {
  const a = ProposedAction.parse({
    executionId: "33333333-3333-4333-8333-333333333333",
    stepId: "s1",
    verb: "create_channel",
    args: { name: "inc-2026-10-05" },
    origin: "https://acme.slack.com",
    path: "/admin/channels",
    targetHash: "a".repeat(64),
    targetName: "Create channel",
  });
  assert.equal(a.targetHash?.length, 64);
});
