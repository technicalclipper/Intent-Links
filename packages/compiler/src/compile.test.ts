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
  assert.equal(intent.steps.length, 5);
  assert.equal(intent.params.length, 3);
  assert.equal(intent.status, "draft");
});

test("parameterization: the channel name varies, the visibility does not", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });

  const create = intent.steps.find((s) => s.id === "s1")!;
  assert.deepEqual(create.action.args["name"], { param: "incident_slug" });

  const visibility = intent.steps.find((s) => s.id === "s2")!;
  assert.deepEqual(visibility.action.args["visibility"], { literal: "private" });
});

test("a condition is extracted from a single observation plus narration", () => {
  const intent = toIntentLink(clone(), { ...CTX, trace });
  const priority = intent.steps.find((s) => s.id === "s5")!;
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
    intent.steps.find((s) => s.id === "s5")!.action.args["value"],
    { literal: "Highest" },
  );
});

test("reconstructing a redacted value is rejected", () => {
  const raw = clone();
  raw.steps.push({
    id: "s9",
    title: "Assign the issue",
    app: "jira",
    verb: "set_field",
    object: "assignee",
    // Event 9 is the redacted assignee. Emitting any literal for a step
    // derived from it means the model tried to reconstruct what the recorder
    // deliberately withheld.
    args: [{ name: "assignee", kind: "literal", value: "Sev2: payments degraded" }],
    dependsOn: ["s4"],
    sourceEvents: [9],
  });
  expectProblem(raw, /redacted event/);
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
  assert.equal(parseJson(body).steps.length, 5);
  assert.equal(parseJson("```json\n" + body + "\n```").steps.length, 5);
  assert.equal(parseJson("Here you go:\n" + body + "\nHope that helps!").steps.length, 5);
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
    intent.steps.find((s) => s.id === "s2")!.action.args["visibility"],
    { literal: "private" },
  );
  assert.deepEqual(
    intent.steps.find((s) => s.id === "s4")!.action.args["project"],
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
