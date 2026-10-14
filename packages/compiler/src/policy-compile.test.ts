import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Trace } from "@intentlink/schema";
import { evaluate } from "@intentlink/policy";
import { toIntentLink, type RawCompilation } from "./parse.js";
import { compilePolicy, explain, parsePolicyJson } from "./policy-compile.js";
import { actionForStep, analyze, buildPolicy, type RawPolicy } from "./policy-validate.js";
import { renderActionSpace } from "./policy-prompt.js";
import type { ModelClient } from "./compile.js";

const read = (u: string) => JSON.parse(readFileSync(new URL(u, import.meta.url), "utf8"));

const trace = Trace.parse(read("../../schema/fixtures/trace.slack-jira.json"));
const intent = toIntentLink(read("../fixtures/golden.incident.json") as RawCompilation, {
  trace,
  intentId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  createdBy: "sre-lead@acme.com",
  now: new Date("2026-10-12T10:00:00.000Z"),
});

const CTX = {
  intent,
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  origins: { slack: "https://acme.slack.com", jira: "https://acme.atlassian.net" },
  now: new Date("2026-10-12T10:00:00.000Z"),
};

/** A policy that permits exactly what the workflow does, plus real boundaries. */
const WELL_FORMED: RawPolicy = {
  rules: [
    { sourceText: "run the incident setup", kind: "allow", verb: "open_dialog", boundSteps: ["s1", "s5"], reasoning: "the forms have to be opened" },
    { sourceText: "run the incident setup", kind: "allow", verb: "set_field", boundSteps: ["s2", "s6", "s7"], reasoning: "the fields it fills" },
    { sourceText: "run the incident setup", kind: "allow", verb: "set_setting", boundSteps: ["s3"], reasoning: "visibility" },
    { sourceText: "run the incident setup", kind: "allow", verb: "set_topic", boundSteps: ["s4"], reasoning: "topic" },
    {
      sourceText: "don't invite anyone outside the company",
      kind: "deny",
      verb: "invite_user",
      args: [{ arg: "email", op: "not_matches", value: ".*@acme\\.com$" }],
      boundSteps: [],
      reasoning: "external invites are forbidden",
    },
    { sourceText: "don't delete anything", kind: "deny", verb: "delete_*", boundSteps: [], reasoning: "nothing destructive" },
    {
      sourceText: "ask me before paging anyone",
      kind: "approval",
      verb: "send_page",
      route: "creator",
      boundSteps: [],
      reasoning: "external paging needs the creator",
    },
  ],
  scope: { origins: ["https://acme.slack.com", "https://acme.atlassian.net"] },
  expiryHours: 24,
  unmatchedClauses: [],
};

const clone = (): RawPolicy => JSON.parse(JSON.stringify(WELL_FORMED));

function scripted(...responses: unknown[]): ModelClient & { calls: number } {
  const client = {
    calls: 0,
    async generate() {
      const next = responses[Math.min(client.calls, responses.length - 1)];
      client.calls++;
      return typeof next === "string" ? next : JSON.stringify(next);
    },
  };
  return client;
}

/* --------------------------------- prompt --------------------------------- */

test("the prompt grounds the model in the workflow's real action space", () => {
  const rendered = renderActionSpace(intent);
  // Without this the model invents verbs that match nothing, and the policy is
  // decorative: rules that look right in review and never fire.
  assert.match(rendered, /open_dialog/);
  assert.match(rendered, /incident_slug/);
  assert.match(rendered, /s5\b/);
});

test("the prompt offers verbs the workflow does NOT perform", () => {
  // A boundary is usually about what the agent must not do, and those verbs
  // by definition never appear in the recording.
  const rendered = renderActionSpace(intent);
  assert.match(rendered, /delete_\*/);
  assert.match(rendered, /invite_user/);
  // ...but does not repeat the workflow's own verbs in that list.
  const adjacent = rendered.slice(rendered.indexOf("RELATED ACTIONS"));
  assert.ok(!adjacent.includes("set_topic"));
});

/* -------------------------------- building -------------------------------- */

test("rules become allow / deny / approval buckets", () => {
  const policy = buildPolicy(clone(), CTX);
  // Five from the creator, plus the implicit observation allow.
  // Four from the creator, plus implicit observation, plus implicit
  // permission for any recorded verb the creator did not mention.
  assert.equal(policy.allowed.length, 5);
  assert.equal(policy.denied.length, 2);
  assert.equal(policy.approvalRequired.length, 1);
});

test("observation is permitted implicitly, so a workflow can start at all", () => {
  // No creator writes "you may look at the screen", but read_page is how the
  // agent perceives anything. Without this every policy denies observation by
  // default - which is exactly what happened in the first live run.
  const policy = buildPolicy(clone(), CTX);
  const observe = policy.allowed.find((r) => r.verb === "read_page");
  assert.ok(observe, "reading the page must be permitted");
  assert.match(observe.sourceText ?? "", /implicit/);
});

test("an explicit read_page rule is not duplicated", () => {
  const raw = clone();
  raw.rules.push({
    sourceText: "it may read anything in the incident channel",
    kind: "allow",
    verb: "read_page",
    boundSteps: [],
    reasoning: "explicit",
  });
  const policy = buildPolicy(raw, CTX);
  assert.equal(policy.allowed.filter((r) => r.verb === "read_page").length, 1);
});

test("every rule keeps the creator's sentence for the block screen", () => {
  const policy = buildPolicy(clone(), CTX);
  const rule = policy.denied.find((r) => r.verb === "invite_user")!;
  assert.equal(rule.sourceText, "don't invite anyone outside the company");
});

test("'ask me' defaults to the creator, never the receiver", () => {
  const raw = clone();
  delete raw.rules.find((r) => r.kind === "approval")!.route;
  const policy = buildPolicy(raw, CTX);
  // Routing to the receiver would let whoever runs the workflow approve their
  // own action, which is not what "ask me" means.
  assert.equal(policy.approvalRequired[0]!.route, "creator");
});

test("numeric constraint values are coerced out of their string spellings", () => {
  const raw = clone();
  raw.limits = { numeric: [{ arg: "amount", op: "lte", value: "5000" }] };
  const policy = buildPolicy(raw, CTX);
  assert.equal(policy.limits.numeric[0]!.value, 5000);
});

test("in / not_in values are split into real lists", () => {
  const raw = clone();
  raw.rules.push({
    sourceText: "never post in #general",
    kind: "deny",
    verb: "post_message",
    args: [{ arg: "channel", op: "in", value: "general, announcements" }],
    boundSteps: [],
    reasoning: "",
  });
  const policy = buildPolicy(raw, CTX);
  const rule = policy.denied.find((r) => r.verb === "post_message")!;
  assert.deepEqual(rule.args[0]!.value, ["general", "announcements"]);
});

/* ------------------------- coverage, by simulation ------------------------ */

test("a well-formed policy lets every step through", () => {
  const policy = buildPolicy(clone(), CTX);
  const { runnable, diagnostics } = analyze(policy, clone(), CTX);
  assert.equal(runnable, true);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
});

test("coverage is judged by the REAL engine, not a second implementation", () => {
  // If the compiler re-implemented "would this be allowed?", the review screen
  // and execution would drift apart. Same function, same answer.
  const policy = buildPolicy(clone(), CTX);
  for (const step of intent.steps) {
    const decision = evaluate(policy, actionForStep(step, intent, CTX.origins), {
      now: CTX.now,
      receiver: "someone@acme.com",
    });
    assert.equal(decision.outcome, "ALLOW", `${step.id} should be allowed`);
  }
});

test("a boundary that blocks the workflow's own step is reported, with the sentence", () => {
  const raw = clone();
  raw.rules.push({
    sourceText: "don't change any fields on issues",
    kind: "deny",
    verb: "set_field",
    boundSteps: ["s7"],
    reasoning: "no field edits",
  });
  const policy = buildPolicy(raw, CTX);
  const { runnable, diagnostics } = analyze(policy, raw, CTX);

  assert.equal(runnable, false);
  const blocked = diagnostics.find((d) => d.code === "step_blocked");
  assert.ok(blocked, "the clash must be surfaced");
  assert.equal(blocked.stepId, "s2");
  assert.match(blocked.message, /don't change any fields on issues/);
});

test("a recorded step runs without the creator having to permit it", () => {
  // People describe outcomes, not mechanics. Someone who writes "change the
  // mode and like the video" has not mentioned searching - and a policy that
  // only permits what was mentioned forbids the navigation that gets there.
  const raw = clone();
  raw.rules = raw.rules.filter((r) => r.kind !== "allow");

  const policy = buildPolicy(raw, CTX);
  const { runnable, diagnostics } = analyze(policy, raw, CTX);

  assert.equal(runnable, true, "the recording is the grant");
  assert.deepEqual(diagnostics.filter((d) => d.code === "step_uncovered"), []);
});

test("a constrained allow is NOT replaced by the implicit permission", () => {
  // The whole point of "only change the mode to light mode". Overwriting it
  // with a blanket allow would discard the restriction while appearing to
  // honour the sentence.
  const raw = clone();
  raw.rules = raw.rules.filter((r) => r.kind !== "allow");
  raw.rules.push({
    sourceText: "only change the mode to light mode",
    kind: "allow",
    verb: "set_setting",
    args: [{ arg: "visibility", op: "matches", value: "[Ll]ight" }],
    boundSteps: ["s3"],
    reasoning: "constrained to light",
  });

  const policy = buildPolicy(raw, CTX);
  const rules = policy.allowed.filter((r) => r.verb === "set_setting");
  assert.equal(rules.length, 1, "exactly one rule governs the verb");
  assert.equal(rules[0]!.args.length, 1, "and it is the constrained one");
});

test("a deny still beats the implicit permission", () => {
  const raw = clone();
  raw.rules = raw.rules.filter((r) => r.kind !== "allow");
  raw.rules.push({
    sourceText: "do not touch issues at all",
    kind: "deny",
    verb: "set_topic",
    boundSteps: ["s4"],
    reasoning: "",
  });

  const policy = buildPolicy(raw, CTX);
  const { runnable, diagnostics } = analyze(policy, raw, CTX);
  assert.equal(runnable, false);
  assert.ok(diagnostics.some((d) => d.code === "step_blocked" && d.stepId === "s4"));
});

test("a step that will pause for approval every run is a warning, not an error", () => {
  const raw = clone();
  raw.rules.push({
    sourceText: "ask me before setting priority",
    kind: "approval",
    verb: "set_field",
    object: "priority",
    route: "creator",
    boundSteps: ["s7"],
    reasoning: "",
  });
  const policy = buildPolicy(raw, CTX);
  const { runnable, diagnostics } = analyze(policy, raw, CTX);

  assert.equal(runnable, true, "approval is a pause, not a block");
  assert.ok(diagnostics.some((d) => d.code === "step_needs_approval" && d.stepId === "s7"));
});

/* ------------------------------- diagnostics ------------------------------ */

test("a clause the model could not compile is an ERROR, never silently dropped", () => {
  const raw = clone();
  raw.unmatchedClauses = ["only during business hours in Singapore"];
  const policy = buildPolicy(raw, CTX);
  const { diagnostics } = analyze(policy, raw, CTX);

  const unmatched = diagnostics.find((d) => d.code === "unmatched_clause");
  assert.ok(unmatched);
  assert.equal(unmatched.severity, "error");
  // The creator believing they are protected when they are not is the worst
  // outcome available here.
  assert.match(unmatched.message, /will NOT be applied/);
});

test("an allow-everything rule is flagged", () => {
  const raw = clone();
  raw.rules.push({ sourceText: "let it do its thing", kind: "allow", verb: "*", boundSteps: [], reasoning: "" });
  const policy = buildPolicy(raw, CTX);
  const { diagnostics } = analyze(policy, raw, CTX);
  assert.ok(diagnostics.some((d) => d.code === "overbroad_allow"));
});

test("'ask me' routed to the receiver is flagged as self-approval", () => {
  const raw = clone();
  const approval = raw.rules.find((r) => r.kind === "approval")!;
  approval.route = "receiver";
  const policy = buildPolicy(raw, CTX);
  const { diagnostics } = analyze(policy, raw, CTX);
  assert.ok(diagnostics.some((d) => d.code === "self_approval"));
});

/* -------------------------------- pipeline -------------------------------- */

test("a clean policy compiles in one call and is runnable", async () => {
  const model = scripted(WELL_FORMED);
  const result = await compilePolicy(model, intent, "don't delete anything", CTX);
  assert.equal(result.attempts, 1);
  assert.equal(result.runnable, true);
});

test("a self-blocking policy is reconsidered once", async () => {
  const blocking = clone();
  blocking.rules.push({
    sourceText: "only change the topic",
    kind: "deny",
    verb: "set_topic",
    boundSteps: ["s3"],
    reasoning: "",
  });

  // A real case: "only change X" is a CONSTRAINT on X, not a ban on it, and a
  // model that reads it as a prohibition blocks the step the sentence was
  // written to protect. One retry, with the clash named, usually fixes it.
  const model = scripted(blocking, WELL_FORMED);
  const result = await compilePolicy(model, intent, "only change the topic", CTX);

  assert.equal(model.calls, 2, "the clash must be put back to the model once");
  assert.equal(result.runnable, true);
});

test("a model that stands its ground has the block REPORTED, not hidden", async () => {
  const blocking = clone();
  blocking.rules.push({
    sourceText: "do not touch issues at all",
    kind: "deny",
    verb: "set_topic",
    boundSteps: ["s4"],
    reasoning: "the creator really did forbid this",
  });

  // People do write contradictory instructions. When the model returns the
  // same deny after reconsidering, that is an answer - so the clash is
  // surfaced rather than retried until the boundary is watered down.
  const model = scripted(blocking);
  const result = await compilePolicy(model, intent, "do not touch issues at all", CTX);

  assert.equal(result.runnable, false);
  assert.ok(result.diagnostics.some((d) => d.code === "step_blocked"));
  assert.match(
    result.diagnostics.find((d) => d.code === "step_blocked")!.message,
    /do not touch issues at all/,
  );
});

test("an unusable response is repaired", async () => {
  const model = scripted("not json at all", WELL_FORMED);
  const notes: string[] = [];
  const result = await compilePolicy(model, intent, "x", { ...CTX, onAttempt: (_, n) => notes.push(n) });
  assert.equal(result.attempts, 2);
  assert.match(notes[0]!, /unusable/);
});

test("policy JSON wrapped in a fence is recovered", () => {
  const body = JSON.stringify(WELL_FORMED);
  assert.equal(parsePolicyJson("```json\n" + body + "\n```").rules.length, WELL_FORMED.rules.length);
});

test("explain() shows each sentence, what it became, and what it touches", () => {
  const policy = buildPolicy(clone(), CTX);
  const analysis = analyze(policy, clone(), CTX);
  const text = explain({ policy, ...analysis });

  assert.match(text, /don't invite anyone outside the company/);
  assert.match(text, /DENY/);
  assert.match(text, /applies to: s1/);
  assert.match(text, /workflow can run/);
});
