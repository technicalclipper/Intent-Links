/**
 * Prompt for the policy compiler.
 *
 * What makes this different from a prompt box: the model is handed the
 * compiled workflow's ACTUAL action space — the verbs, objects, parameters and
 * origins that exist — so a rule it emits binds to real things that can be
 * checked. "Don't invite anyone outside the company" compiles against a known
 * `invite_user` verb with a known `email` argument, not against a guess.
 *
 * That grounding is also what makes the result reviewable. Every rule carries
 * the creator's own sentence and the steps it touches, so the UI can show
 * which clause produced which rule and what it will stop.
 */

import type { IntentLink } from "@intentlink/schema";

export const POLICY_RESPONSE_SCHEMA = {
  type: "object",
  required: ["rules", "scope", "expiryHours", "unmatchedClauses"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        required: ["sourceText", "kind", "verb", "boundSteps", "reasoning"],
        properties: {
          sourceText: {
            type: "string",
            description:
              "the creator's own words that produced this rule, verbatim. When "
              + "no sentence of theirs produced it (an allow you synthesised to "
              + "cover the workflow), write one short plain-English sentence a "
              + "person would recognise - never a verb signature or argument list.",
          },
          kind: { type: "string", enum: ["allow", "deny", "approval"] },
          verb: {
            type: "string",
            description: "semantic verb or glob, e.g. create_issue or delete_*",
          },
          object: { type: "string" },
          args: {
            type: "array",
            items: {
              type: "object",
              required: ["arg", "op", "value"],
              properties: {
                arg: { type: "string" },
                op: {
                  type: "string",
                  enum: [
                    "eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte",
                    "matches", "not_matches",
                  ],
                },
                value: { type: "string" },
              },
            },
          },
          route: {
            type: "string",
            enum: ["receiver", "creator", "two_party"],
            description: "approval only; creator or two_party prevents self-approval",
          },
          requireJustification: { type: "boolean" },
          boundSteps: {
            type: "array",
            items: { type: "string" },
            description: "ids of workflow steps this rule applies to; empty if none",
          },
          reasoning: { type: "string" },
        },
      },
    },
    scope: {
      type: "object",
      properties: {
        origins: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "string" } },
        dataExclusions: { type: "array", items: { type: "string" } },
      },
    },
    limits: {
      type: "object",
      properties: {
        numeric: {
          type: "array",
          items: {
            type: "object",
            required: ["arg", "op", "value"],
            properties: {
              arg: { type: "string" },
              op: { type: "string", enum: ["lt", "lte", "gt", "gte"] },
              value: { type: "string" },
            },
          },
        },
        maxActions: { type: "number" },
        maxExecutions: { type: "number" },
        rateLimit: { type: "number" },
      },
    },
    expiryHours: { type: "number" },
    receivers: { type: "array", items: { type: "string" } },
    unmatchedClauses: {
      type: "array",
      items: { type: "string" },
      description: "anything the creator said that you could NOT turn into a rule",
    },
  },
} as const;

export const POLICY_SYSTEM_INSTRUCTION = `
You compile a person's plain-English boundaries into an enforceable policy.

The policy is evaluated by a deterministic engine, not by a model. You are
writing rules that will be machine-checked before every action, so they must be
precise about verbs, objects and arguments. Vagueness here becomes either a
workflow that cannot run or an authority that is wider than intended.

WHAT YOU ARE AND ARE NOT DECIDING

The recording is the grant. The creator demonstrated these steps, which
authorizes them; nobody records work they do not want done. Every step below
is permitted already, and you do NOT need to emit an allow rule to enable one.

Your job is the restriction: what must not happen, what needs a human first,
and what limits apply to the steps that do run.

This matters because people describe outcomes, not mechanics. "Change the mode
to light and like the video" leaves out searching, opening the video and
scrolling - the moves that get there. Reading that as the complete list of
permissions would forbid the navigation the workflow depends on.

EMIT AN ALLOW RULE ONLY TO CONSTRAIN ONE

An allow rule you write REPLACES the implicit permission for that verb, so use
one when the creator restricted how a step may run:

  "only change the mode to light mode"
    -> allow set_theme where theme matches [Ll]ight

Never write a bare allow for a step that already exists. It adds nothing, and
if the creator constrained that step you will have overwritten the constraint
with a blanket permission.

PRECEDENCE

deny beats approval beats allow. A deny rule does not need an allow rule to
argue with; it simply wins.

BE SPECIFIC, NOT BROAD

Prefer the narrowest rule that expresses the intent.
  "never post in #general"  ->  deny post_message where channel in [general]
  NOT                           deny post_message

Reserve wildcards for genuinely open-ended prohibitions ("don't delete
anything" -> deny delete_*). Never emit an allow rule with verb "*".

"ONLY" IS A CONSTRAINT, NOT A PROHIBITION

This is the most common way to get a policy wrong, so read it twice.

"Only change the mode to light mode" does NOT forbid changing the mode. It
PERMITS changing the mode, and restricts the value:

  allow set_theme where theme matches light
  NOT  deny set_theme

Likewise "don't touch any other settings", "nothing else", "just the topic",
"leave everything else alone". These are SCOPING statements. They say: the
workflow's own steps are fine, and things outside it are not. Compiling them
as blanket denials blocks the very workflow they were written to protect.

DENY STILL WINS

A deny rule beats the implicit permission, so "never delete anything" works
even though deleting was never demonstrated, and a deny that lands on a
recorded step genuinely stops it.

THE TEST YOU MUST APPLY TO EVERY DENY RULE

Before emitting a deny, check it against the workflow steps listed below. If it
matches one of them, you have almost certainly misread the sentence - it is a
constraint on that step's arguments, not a ban on the step.

A creator CAN genuinely forbid something their own workflow does; people write
contradictory instructions. But that is rare, and if you conclude it is what
happened, say so in unmatchedClauses rather than silently producing a policy
that cannot run.

HOW LONG THE LINK LASTS

expiryHours is how long the link stays usable. Set it ONLY from a lifetime the
creator actually states ("valid for 2 hours", "expires Friday", "just for
today"). If they say nothing about time, use 720 (30 days). Do not shorten it
because a workflow seems sensitive: the boundaries say what is forbidden, and
a link that dies after a day is simply a link nobody can use.

ARGUMENT CONSTRAINTS CARRY THE MEANING

"Don't invite anyone outside the company" is not a ban on inviting. It is a ban
on inviting an address that does not match the company domain:
  deny invite_user where email not_matches .*@acme\\.com$

"Budget cap of 5000" is a numeric limit on the amount argument, not a deny.

APPROVALS

"Ask me before X" is an approval rule, not a deny. Route it to "creator" when
the creator says "ask me" — routing to the receiver would let the person
running the workflow approve their own action, which is not what "ask me"
means.

BIND TO STEPS

For every rule, list the ids of the workflow steps it applies to. A deny rule
that blocks a step the workflow needs is reported to the creator, so this
binding has to be honest — do not leave boundSteps empty to avoid a conflict.

ADMIT WHAT YOU COULD NOT COMPILE

If a RESTRICTION cannot be expressed as a rule over the available action
space, put it in unmatchedClauses verbatim. A boundary silently dropped is
worse than one the creator is told about: they believe they are protected and
they are not.

unmatchedClauses is for RESTRICTIONS ONLY, and most of a sentence is not one.

A restriction forbids something, limits it, or requires someone to approve it.
If a fragment does none of those, it does not belong here at all - not even to
note that you could not compile it.

  "from dark mode"            the state it starts in. Context.
  "go to youtube.com"         where the work happens. Context.
  "and like the video"        something to DO. The recording granted it.
  "the one I searched for"    which thing. Context.

  "don't delete anything"     a restriction.
  "only light mode"           a restriction (on a value).
  "ask me before sending"     a restriction (an approval).

Do not break a sentence into fragments looking for things to report. A
creator writing "change it to light mode from dark mode" has stated ONE
intention and zero restrictions, and reporting "from dark mode" as an
unenforceable boundary tells the receiver something is wrong when nothing is.
`.trim();

/**
 * Describe the action space the policy will govern.
 *
 * Without this the model invents verb names that match nothing and the policy
 * is decorative — rules that look right in review and never fire.
 */
export function renderActionSpace(intent: IntentLink): string {
  const lines: string[] = [];

  lines.push(`GOAL: ${intent.goal}`);
  lines.push("");
  lines.push("WORKFLOW STEPS (the only actions this IntentLink performs)");
  for (const step of intent.steps) {
    const args = Object.entries(step.action.args)
      .map(([name, value]) =>
        "param" in value ? `${name}=<${value.param}>` : `${name}=${JSON.stringify(value.literal)}`,
      )
      .join(" ");
    const object = step.action.object ? ` object=${step.action.object}` : "";
    lines.push(`  ${step.id}  [${step.app}] ${step.action.verb}${object} ${args}`.trimEnd());
    if (step.condition) lines.push(`        only when: ${step.condition}`);
  }

  lines.push("");
  lines.push("PARAMETERS the receiver supplies");
  for (const param of intent.params) {
    const enums = param.enumValues?.length ? ` one of [${param.enumValues.join(", ")}]` : "";
    lines.push(`  ${param.name}: ${param.type}${enums}  e.g. ${JSON.stringify(param.recordedExample ?? "")}`);
  }

  const apps = [...new Set(intent.steps.map((s) => s.app))];
  lines.push("");
  lines.push(`APPS INVOLVED: ${apps.join(", ")}`);

  lines.push("");
  lines.push(
    "RELATED ACTIONS the receiver's agent could attempt but this workflow does not perform.",
  );
  lines.push(
    "Rules may reference these: the creator is usually forbidding something the",
  );
  lines.push("workflow never does, which is exactly what a boundary is for.");
  for (const verb of adjacentVerbs(intent)) lines.push(`  ${verb}`);

  return lines.join("\n");
}

/**
 * Verbs a creator plausibly wants to forbid.
 *
 * A boundary is usually about what the agent must NOT do, and those verbs by
 * definition do not appear in the recording. Offering a vocabulary stops the
 * model inventing one that never matches anything at run time.
 */
function adjacentVerbs(intent: IntentLink): string[] {
  /*
   * A vocabulary of things a person might forbid, phrased for ANY web app
   * rather than for one industry.
   *
   * This bounds what boundaries can be expressed at all: on the first real
   * end-to-end run the creator wrote "ask me before paging anyone externally"
   * and the model correctly reported it as uncompilable, because there was no
   * paging verb to bind it to. The honest report was right, but a boundary a
   * person naturally reaches for should have somewhere to land.
   *
   * These are shapes of risk, not features of a product: destroying, granting,
   * spending, publishing, sharing, and reaching people outside.
   */
  const verbs = new Set<string>([
    // destroy
    "delete_*",
    "remove_*",
    "archive_*",
    "clear_*",
    "reset_*",
    // authority
    "grant_role",
    "change_permissions",
    "revoke_access",
    "invite_user",
    "transfer_ownership",
    "change_password",
    // money
    "modify_billing",
    "start_subscription",
    "cancel_subscription",
    "make_purchase",
    // reaching people
    "send_email",
    "send_message",
    "post_message",
    "post_comment",
    "send_page",
    "notify_external",
    // visibility
    "publish_*",
    "make_public",
    "share_externally",
    "export_data",
    "upload_file",
    // configuration
    "set_setting",
    "disable_*",
    "enable_*",
  ]);

  // The workflow's own verbs are listed separately above; repeating them here
  // would invite rules that duplicate what the steps already describe.
  for (const step of intent.steps) verbs.delete(step.action.verb);
  return [...verbs];
}

export function buildPolicyPrompt(intent: IntentLink, boundaries: string): string {
  return [
    "Compile these boundaries into a policy for the workflow below.",
    "",
    "THE CREATOR'S BOUNDARIES, verbatim:",
    JSON.stringify(boundaries),
    "",
    renderActionSpace(intent),
  ].join("\n");
}
