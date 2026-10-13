import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Policy, type ProposedAction } from "@intentlink/schema";
import { evaluate, evaluateForPreview, type EvalContext } from "./engine.js";
import { uncompilablePatterns } from "./match.js";

const basePolicy = Policy.parse(
  JSON.parse(
    readFileSync(
      new URL("../../schema/fixtures/policy.incident-channel.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** Fixed clock, comfortably inside the fixture's validity window. */
const NOW = new Date("2026-10-05T10:00:00.000Z");
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  now: NOW,
  receiver: "platform@acme.com",
  ...over,
});

const act = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  executionId: "33333333-3333-4333-8333-333333333333",
  stepId: "s1",
  verb: "create_channel",
  object: "channel",
  args: {},
  origin: "https://acme.slack.com",
  path: "/admin/channels",
  ...over,
});

const policyWith = (over: Partial<Policy>): Policy => Policy.parse({ ...basePolicy, ...over });

/* ------------------------------- happy path ------------------------------- */

test("allows an action the creator explicitly permitted", () => {
  const d = evaluate(basePolicy, act(), ctx());
  assert.equal(d.outcome, "ALLOW");
  assert.equal(d.ruleId, "a1");
});

test("allows only when arg constraints hold", () => {
  const ok = evaluate(
    basePolicy,
    act({ verb: "create_issue", object: "issue", args: { project: "INC" } }),
    ctx(),
  );
  assert.equal(ok.outcome, "ALLOW");

  const wrongProject = evaluate(
    basePolicy,
    act({ verb: "create_issue", object: "issue", args: { project: "FINANCE" } }),
    ctx(),
  );
  assert.equal(wrongProject.outcome, "DENY");
});

/* ------------------------- deny by default & rules ------------------------ */

test("denies anything the creator never allowed", () => {
  const d = evaluate(basePolicy, act({ verb: "archive_project", object: "project" }), ctx());
  assert.equal(d.outcome, "DENY");
});

test("an explicit deny rule beats a matching allow rule", () => {
  const p = policyWith({
    allowed: [{ id: "a9", verb: "set_setting", object: "*", args: [], boundSteps: [] }],
    denied: [
      {
        id: "d9",
        verb: "set_setting",
        object: "workspace_*",
        args: [],
        sourceText: "don't touch workspace settings",
        boundSteps: [],
      },
    ],
  });
  const d = evaluate(p, act({ verb: "set_setting", object: "workspace_retention" }), ctx());
  assert.equal(d.outcome, "DENY");
  assert.equal(d.ruleId, "d9");
  assert.match(d.reason, /don't touch workspace settings/);
});

test("the block cites the creator's own sentence verbatim", () => {
  const d = evaluate(
    basePolicy,
    act({ verb: "invite_user", args: { email: "contractor@other.com" } }),
    ctx(),
  );
  assert.equal(d.outcome, "DENY");
  assert.equal(d.sourceText, "don't invite anyone outside the company");
});

test("the same rule permits an internal invite", () => {
  const d = evaluate(
    basePolicy,
    act({ verb: "invite_user", args: { email: "sre@acme.com" } }),
    ctx(),
  );
  // Not denied by d1 — but still not allowed, because nothing allows it.
  assert.equal(d.outcome, "DENY");
  assert.notEqual(d.ruleId, "d1");
});

test("the most specific matching rule is the one reported", () => {
  const p = policyWith({
    denied: [
      { id: "broad", verb: "*", args: [], boundSteps: [] },
      { id: "exact", verb: "delete_channel", args: [], boundSteps: [] },
    ],
  });
  const d = evaluate(p, act({ verb: "delete_channel" }), ctx());
  assert.equal(d.ruleId, "exact");
});

/* --------------------- destructive verbs: the safety net ------------------ */

test("irreversible verbs are denied even when no rule mentions them", () => {
  const p = policyWith({ denied: [], allowed: [] });
  for (const verb of ["delete_project", "revoke_access", "transfer_ownership", "pay_invoice"]) {
    const d = evaluate(p, act({ verb }), ctx());
    assert.equal(d.outcome, "DENY", `${verb} must be denied by default`);
    assert.match(d.reason, /irreversible/);
  }
});

test("a destructively-named control is caught even when the verb looks benign", () => {
  const p = policyWith({ denied: [], allowed: [] });
  const d = evaluate(p, act({ verb: "click_button", targetName: "Delete workspace" }), ctx());
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /irreversible/);
});

test("an explicitly allowed destructive action still goes through", () => {
  const p = policyWith({
    denied: [],
    allowed: [
      { id: "ok", verb: "delete_channel", args: [], sourceText: "clean up the temp channel", boundSteps: [] },
    ],
  });
  const d = evaluate(p, act({ verb: "delete_channel" }), ctx());
  assert.equal(d.outcome, "ALLOW");
});

/* -------------------------------- approval -------------------------------- */

test("approval-required actions return APPROVAL with their route", () => {
  const d = evaluate(basePolicy, act({ verb: "send_page", object: "pager" }), ctx());
  assert.equal(d.outcome, "APPROVAL");
  assert.equal(d.approvalRoute, "creator", "routing to the creator prevents self-approval");
  assert.match(d.reason, /ask me before paging/);
});

/* ------------------------------- lifecycle -------------------------------- */

test("expiry denies, mid-execution included", () => {
  // Sets its own expiry rather than leaning on the fixture's. The fixture is
  // also used for manual testing, so its date moves; a test that depends on
  // it silently stops testing expiry when it does.
  const p = policyWith({ expiresAt: "2026-10-06T09:20:00.000Z" });
  const d = evaluate(p, act(), ctx({ now: new Date("2026-10-07T00:00:00.000Z") }));
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /expired/);
});

test("revocation denies immediately", () => {
  const p = policyWith({ revokedAt: "2026-10-05T09:30:00.000Z" });
  const d = evaluate(p, act(), ctx());
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /revoked/);
});

test("a policy edited after the run started cannot take effect", () => {
  const p = policyWith({ hash: "b".repeat(64) });
  const d = evaluate(p, act(), ctx({ pinnedPolicyHash: "a".repeat(64) }));
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /changed after this execution started/);
});

/* ------------------------------ who and where ----------------------------- */

test("receiver allowlist accepts a domain entry and rejects outsiders", () => {
  assert.equal(evaluate(basePolicy, act(), ctx({ receiver: "anyone@acme.com" })).outcome, "ALLOW");
  const outsider = evaluate(basePolicy, act(), ctx({ receiver: "someone@other.com" }));
  assert.equal(outsider.outcome, "DENY");
  assert.match(outsider.reason, /shared with specific people/);
});

test("an action outside the permitted origins is denied", () => {
  const d = evaluate(basePolicy, act({ origin: "https://evil.example.com" }), ctx());
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /outside the origins/);
});

test("an action outside the permitted paths is denied", () => {
  const d = evaluate(basePolicy, act({ path: "/admin/billing" }), ctx());
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /outside the paths/);
});

/* -------------------------------- budgets --------------------------------- */

test("numeric ceilings deny over-limit args", () => {
  const p = policyWith({
    allowed: [{ id: "b1", verb: "create_budget", args: [], boundSteps: [] }],
    limits: { ...basePolicy.limits, numeric: [{ arg: "amount", op: "lte", value: 5000 }] },
  });
  assert.equal(
    evaluate(p, act({ verb: "create_budget", object: undefined, args: { amount: 4800 } }), ctx()).outcome,
    "ALLOW",
  );
  const over = evaluate(
    p,
    act({ verb: "create_budget", object: undefined, args: { amount: 52000 } }),
    ctx(),
  );
  assert.equal(over.outcome, "DENY");
  assert.match(over.reason, /exceeds the limit/);
});

test("action ceiling, rate limit and execution count each deny", () => {
  assert.match(evaluate(basePolicy, act(), ctx({ actionsUsed: 40 })).reason, /ceiling of 40/);
  assert.match(evaluate(basePolicy, act(), ctx({ actionsInLastMinute: 30 })).reason, /Rate limit/);
  assert.match(evaluate(basePolicy, act(), ctx({ executionsUsed: 1 })).reason, /already been used/);
});

/* -------------------- the agent cannot invent what it types --------------- */

test("values must come from a parameter or the recording", () => {
  const allowedValues = ["inc-2026-10-05-payments", "Sev2: payments degraded"];
  const ok = evaluate(
    basePolicy,
    act({ args: { name: "inc-2026-10-05-payments" } }),
    ctx({ allowedValues }),
  );
  assert.equal(ok.outcome, "ALLOW");

  const invented = evaluate(
    basePolicy,
    act({ args: { name: "something-the-model-made-up" } }),
    ctx({ allowedValues }),
  );
  assert.equal(invented.outcome, "DENY");
  assert.match(invented.reason, /neither your parameters nor the recording/);
});

/* --------------------------------- dry run -------------------------------- */

test("preview returns the same verdict but never carries authority", () => {
  const live = evaluate(basePolicy, act(), ctx());
  const preview = evaluateForPreview(basePolicy, act(), ctx());
  assert.equal(preview.outcome, live.outcome);
  assert.equal(preview.token, undefined);
});

/* ------------------------- no path to an accidental yes ------------------- */

test("an empty policy allows nothing at all", () => {
  const p = Policy.parse({
    id: "11111111-1111-4111-8111-111111111111",
    intentId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  for (const verb of ["create_channel", "read_page", "set_field", "anything_at_all"]) {
    assert.equal(evaluate(p, act({ verb, object: undefined }), ctx()).outcome, "DENY");
  }
});

test("a malformed regex in a deny rule fails closed, not open", () => {
  const p = policyWith({
    denied: [
      { id: "bad", verb: "invite_user", args: [{ arg: "email", op: "matches", value: "([" }], boundSteps: [] },
    ],
    allowed: [{ id: "a", verb: "invite_user", args: [], boundSteps: [] }],
  });
  // The broken rule matches nothing, so it cannot deny — but the action is
  // still only permitted because an explicit allow exists. The point is that a
  // broken pattern never silently widens authority.
  const d = evaluate(p, act({ verb: "invite_user", args: { email: "x@acme.com" } }), ctx());
  assert.equal(d.outcome, "ALLOW");
  assert.equal(d.ruleId, "a");
});

test("an approval rule over a destructive verb is reachable, not pre-denied", () => {
  // Regression: the destructive net used to run before approvals and only
  // counted allow rules as acknowledgment, which made every "ask me before
  // <destructive thing>" rule unreachable.
  const p = policyWith({
    allowed: [],
    denied: [],
    approvalRequired: [
      {
        id: "ap",
        verb: "delete_channel",
        args: [],
        route: "creator",
        requireJustification: true,
        grantTtlSeconds: 120,
        sourceText: "ask me before deleting a channel",
        boundSteps: [],
      },
    ],
  });
  const d = evaluate(p, act({ verb: "delete_channel", object: undefined }), ctx());
  assert.equal(d.outcome, "APPROVAL");
  assert.equal(d.approvalRoute, "creator");
});

test("a destructive verb with neither allow nor approval is still denied", () => {
  const p = policyWith({ allowed: [], denied: [], approvalRequired: [] });
  const d = evaluate(p, act({ verb: "delete_channel", object: undefined }), ctx());
  assert.equal(d.outcome, "DENY");
  assert.match(d.reason, /irreversible/);
});

test("a PCRE inline flag is translated rather than failing closed", () => {
  // Cost a real run: the model reasoned correctly and wrote
  //   allow set_theme where theme matches "(?i).*light.*"
  // which JavaScript cannot compile. It fell back to a never-matching pattern,
  // so the rule written to PERMIT the step denied it by default instead.
  const p = policyWith({
    denied: [],
    allowed: [
      {
        id: "a1",
        verb: "set_theme",
        args: [{ arg: "theme", op: "matches", value: "(?i).*light.*" }],
        sourceText: "only change the mode to light mode",
        boundSteps: ["s1"],
      },
    ],
  });

  const light = evaluate(p, act({ verb: "set_theme", object: undefined, args: { theme: "Light theme" } }), ctx());
  assert.equal(light.outcome, "ALLOW", "case-insensitive match must work");

  const dark = evaluate(p, act({ verb: "set_theme", object: undefined, args: { theme: "Dark theme" } }), ctx());
  assert.equal(dark.outcome, "DENY", "and must still exclude other values");
});

test("a genuinely broken pattern is recorded, not just silently inert", () => {
  const p = policyWith({
    denied: [{ id: "d1", verb: "invite_user", args: [{ arg: "email", op: "matches", value: "([" }], boundSteps: [] }],
  });
  evaluate(p, act({ verb: "invite_user", object: undefined, args: { email: "x@y.com" } }), ctx());
  // A boundary that matches nothing is a boundary that does not exist; the
  // creator has to be told rather than left believing they are protected.
  assert.ok(uncompilablePatterns().includes("(["));
});
