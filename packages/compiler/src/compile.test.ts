import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Trace } from "@intentlink/schema";
import { compileIntent, parseJson, type ModelClient } from "./compile.js";
import { CompilationError, observedValues, toIntentLink } from "./parse.js";
import type { RawCompilation } from "./parse.js";
import { renderTrace } from "./prompt.js";

const read = (url: string) => JSON.parse(readFileSync(new URL(url, import.meta.url), "utf8"));

const trace = Trace.parse(
  read("../../schema/fixtures/trace.slack-jira.json"),
);
const golden = read("../fixtures/golden.incident.json") as RawCompilation;

const CTX = {
  intentId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  createdBy: "sre-lead@acme.com",
  now: new Date("2026-10-12T10:00:00.000Z"),
};

const clone = (): RawCompilation => JSON.parse(JSON.stringify(golden));

/** A model that returns whatever we hand it, so the pipeline is testable. */
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

function expectProblem(raw: RawCompilation, match: RegExp): string[] {
  try {
    toIntentLink(raw, { ...CTX, trace });
    assert.fail("expected compilation to be rejected");
  } catch (err) {
    assert.ok(err instanceof CompilationError, "expected a CompilationError");
    assert.ok(
      err.problems.some((p) => match.test(p)),
      `no problem matched ${match}\ngot: ${err.problems.join("; ")}`,
    );
    return err.problems;
  }
}

/* --------------------------------- prompt --------------------------------- */

test("the rendered trace anchors narration to the events it overlaps", () => {
  const rendered = renderTrace(trace);
  assert.match(rendered, /NARRATION/);
  // "Always make the incident channel private first" overlaps the toggle, and
  // tying the two together is what lets the model infer a constant.
  assert.match(rendered, /private first[^\n]*near events/);
});

test("redacted values are described but never reproduced", () => {
  const rendered = renderTrace(trace);
  assert.match(rendered, /REDACTED email value/);
  assert.ok(!rendered.includes("@acme.com"), "a redacted value must not leak into the prompt");
});

/* ------------------------------ the happy path ---------------------------- */

test("the golden compilation validates and becomes an IntentLink", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });
  // One interaction per step, which is what the executor can perform.
  assert.equal(intent.steps.length, 7);
  assert.equal(intent.params.length, 3);
  assert.equal(intent.status, "draft");
});

test("parameterization: the channel name varies, the visibility does not", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });

  const name = intent.steps.find((s) => s.id === "s2")!;
  assert.deepEqual(name.action.args["name"], { param: "incident_slug" });

  const visibility = intent.steps.find((s) => s.id === "s3")!;
  assert.deepEqual(visibility.action.args["visibility"], { literal: "private" });
});

test("a condition is extracted from a single observation plus narration", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });
  const priority = intent.steps.find((s) => s.id === "s7")!;
  // The recording shows exactly one priority. "Highest for a sev2" is what
  // turns that into a branch rather than a constant.
  assert.match(priority.condition ?? "", /sev/);
});

test("hints come from the trace, never from the model", () => {
  const raw = clone();
  const intent = toIntentLink(raw, { ...CTX, trace });
  const create = intent.steps.find((s) => s.id === "s1")!;

  assert.ok(create.hints.length > 0);
  // Every hint must be a descriptor that was actually captured.
  const captured = new Set(
    trace.events.filter((e) => e.target).map((e) => JSON.stringify(e.target)),
  );
  for (const hint of create.hints) {
    assert.ok(captured.has(JSON.stringify(hint)), "hint was not present in the trace");
  }
});

test("verbs stay tool-agnostic", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });
  for (const step of intent.steps) {
    assert.match(step.action.verb, /^[a-z][a-z0-9_]*$/);
    assert.ok(!step.action.verb.includes("."));
  }
});

/* ------------------------- the checks that matter ------------------------- */

test("a hallucinated literal is rejected", () => {
  const raw = clone();
  // Nobody typed this during the recording. If it survived, the policy
  // engine's typed-value allowlist would permit the agent to enter it.
  raw.steps[0]!.args[0] = {
    name: "name",
    kind: "literal",
    value: "inc-made-up-by-the-model",
  };
  expectProblem(raw, /not evidenced by the events this step cites/);
});

test("a literal that WAS demonstrated is accepted", () => {
  const observed = observedValues(trace);
  assert.ok(observed.has("Highest"), "fixture sanity: Highest was demonstrated");
  const intent = toIntentLink(clone(), { ...CTX, trace });
  assert.deepEqual(
    intent.steps.find((s) => s.id === "s7")!.action.args["value"],
    { literal: "Highest" },
  );
});

test("a redacted value cannot be reconstructed as a literal", () => {
  const raw = clone();
  raw.steps.push({
    id: "s9",
    title: "Assign the issue",
    app: "jira",
    verb: "set_field",
    object: "assignee",
    // Event 9 is the redacted assignee. evidenceFor() never admits a redacted
    // event's value, so nothing can justify emitting one.
    args: [{ name: "assignee", kind: "literal", value: "sre-oncall@acme.com" }],
    dependsOn: ["s4"],
    sourceEvents: [9],
  });
  expectProblem(raw, /not evidenced by the events this step cites/);
});

test("a legitimate literal survives on a step that touches a redacted event", () => {
  // The case real models kept failing. An earlier rule banned every literal on
  // any step that merely CITED a redacted event, which rejected a board key
  // for the company its event kept. The restriction belongs on the value.
  const raw = clone();
  const step = raw.steps.find((s) => s.id === "s6")!;
  step.sourceEvents = [9]; // the redacted assignee, and nothing else
  step.args = [
    { name: "project", kind: "literal", value: "INC", rationale: "from the board path" },
  ];

  const intent = toIntentLink(raw, { ...CTX, trace });
  assert.deepEqual(
    intent.steps.find((s) => s.id === "s6")!.action.args["project"],
    { literal: "INC" },
  );
});

test("a tool-shaped verb is rejected", () => {
  for (const verb of ["pubsub.topics.create", "POST_issue", "createIssue", "api/v3/issues"]) {
    const raw = clone();
    raw.steps[0]!.verb = verb;
    expectProblem(raw, /tool call|snake_case/);
  }
});

test("a step citing no events is rejected as invented", () => {
  const raw = clone();
  raw.steps[0]!.sourceEvents = [];
  expectProblem(raw, /cites no source events/);
});

test("a step citing an event that does not exist is rejected", () => {
  const raw = clone();
  raw.steps[0]!.sourceEvents = [999];
  expectProblem(raw, /not in the trace/);
});

test("an undeclared parameter is rejected", () => {
  const raw = clone();
  raw.steps[0]!.args[0] = { name: "name", kind: "param", value: "nonexistent_param" };
  expectProblem(raw, /undeclared parameter/);
});

test("a parameter with no rationale is rejected", () => {
  const raw = clone();
  raw.params[0]!.rationale = "";
  // A parameter the model cannot justify is usually a literal it decided to
  // make configurable, which quietly widens what the agent may type.
  expectProblem(raw, /no rationale/);
});

test("a dependency cycle is caught", () => {
  const raw = clone();
  raw.steps[0]!.dependsOn = ["s3"];
  expectProblem(raw, /cycle/);
});

test("a dependency on an unknown step is caught", () => {
  const raw = clone();
  raw.steps[0]!.dependsOn = ["s42"];
  expectProblem(raw, /unknown step/);
});

test("booleans and numbers are not treated as hallucinated literals", () => {
  const raw = clone();
  // States read off a toggle, not values quoted from the page.
  raw.steps[1]!.args[0] = { name: "enabled", kind: "literal", value: "true" };
  const intent = toIntentLink(raw, { ...CTX, trace });
  assert.deepEqual(intent.steps[1]!.action.args["enabled"], { literal: true });
});

/* ------------------------------ the pipeline ------------------------------ */

test("a clean response compiles in one call", async () => {
  const model = scripted(golden);
  const result = await compileIntent(model, trace, CTX);
  assert.equal(result.attempts, 1);
  assert.equal(model.calls, 1);
});

test("a rejected compilation is repaired on the next attempt", async () => {
  const broken = clone();
  broken.steps[0]!.args[0] = { name: "name", kind: "literal", value: "invented" };

  const problems: string[][] = [];
  const model = scripted(broken, golden);
  const result = await compileIntent(model, trace, {
    ...CTX,
    onAttempt: (_, p) => problems.push(p),
  });

  assert.equal(result.attempts, 2);
  assert.match(problems[0]!.join(" "), /not evidenced by the events/);
  assert.deepEqual(problems[1], []);
});

test("a model that never recovers fails loudly with its problems", async () => {
  const broken = clone();
  broken.steps[0]!.sourceEvents = [999];
  const model = scripted(broken);

  await assert.rejects(
    () => compileIntent(model, trace, { ...CTX, maxRepairs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof CompilationError);
      assert.match(err.message, /could not compile after 2 attempts/);
      return true;
    },
  );
  assert.equal(model.calls, 2);
});

test("JSON wrapped in prose or a fence is still recovered", () => {
  const body = JSON.stringify(golden);
  assert.equal(parseJson(body).steps.length, 7);
  assert.equal(parseJson("```json\n" + body + "\n```").steps.length, 7);
  assert.equal(parseJson("Here you go:\n" + body + "\nHope that helps!").steps.length, 7);
});

test("a response with no usable JSON is reported, not silently empty", () => {
  assert.throws(() => parseJson("I cannot help with that."), /did not contain a usable JSON/);
});

test("constants that were demonstrated without being typed are accepted", () => {
  // The two cases that broke the first version of the evidence check:
  //   "private" came from toggling a switch LABELLED "Make private"
  //   "INC"     came from the route /jira/software/projects/INC/boards/12
  // Both are plainly demonstrated; neither appears in any event's `value`.
  const intent = toIntentLink(clone(), { ...CTX, trace });
  assert.deepEqual(
    intent.steps.find((s) => s.id === "s3")!.action.args["visibility"],
    { literal: "private" },
  );
  assert.deepEqual(
    intent.steps.find((s) => s.id === "s6")!.action.args["project"],
    { literal: "INC" },
  );
});

test("evidence is scoped per step, not pooled across the trace", () => {
  const raw = clone();
  // "Highest" was demonstrated, but on event 8 — which step s1 does not cite.
  // Pooling evidence trace-wide would wrongly accept it here.
  raw.steps[0]!.args.push({ name: "priority", kind: "literal", value: "Highest" });
  expectProblem(raw, /not evidenced by the events this step cites/);
});

test("a step built from a navigation has nothing to act on and is rejected", () => {
  // The executor resolves against recorded descriptors. A step whose events
  // carry none can never match anything on any page, and the run reports
  // "nothing was done" without ever saying why.
  const raw = clone();
  raw.steps[0]!.sourceEvents = [0]; // event 0 is a navigate, no target
  expectProblem(raw, /nothing to act on/);
});

test("a navigation alongside one interaction is fine", () => {
  // A navigation is context for the click beside it, not a second action, so
  // it must not trip the one-interaction rule.
  const raw = clone();
  raw.steps[0]!.sourceEvents = [0, 1];
  const intent = toIntentLink(raw, { ...CTX, trace });
  assert.ok(intent.steps[0]!.hints.length > 0, "it must carry a resolvable hint");
});

test("a step citing several interactions is rejected", () => {
  // The executor performs ONE action per step, so a step citing three clicks
  // performs the first and calls the step done. A real run compiled "open the
  // account menu, open Appearance, choose Light theme" into one set_theme step
  // whose control was the account menu: the menu opened, the step was marked
  // complete, and the theme never changed.
  const raw = clone();
  raw.steps[0]!.sourceEvents = [1, 2, 3];
  const problems = expectProblem(raw, /cites 3 separate controls/);
  assert.ok(problems.some((p) => /only the first would ever be performed/.test(p)));
});

test("navigations alongside one interaction are fine", () => {
  // A navigation is context for the click beside it, not a second action.
  const raw = clone();
  // s1 already cites a navigate plus one click, which is the shape in question.
  const intent = toIntentLink(raw, { ...CTX, trace });
  assert.ok(intent.steps[0]!.hints.length > 0);
});

test("clicking into a field and typing in it is one step", () => {
  // Two recorded events, one thing a person did. Splitting them produced a
  // step whose only job was to put the cursor somewhere, which then failed
  // for having no value to type.
  const raw = clone();
  const step = raw.steps.find((s) => s.id === "s2")!;
  step.sourceEvents = [2, 2]; // same control, cited twice
  assert.doesNotThrow(() => toIntentLink(raw, { ...CTX, trace }));
});

test("two different controls are still two steps", () => {
  const raw = clone();
  raw.steps[0]!.sourceEvents = [1, 2]; // "Create channel" then "Channel name"
  expectProblem(raw, /2 separate controls/);
});
