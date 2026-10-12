/**
 * Prompt construction for the intent compiler.
 *
 * The compiler's job is the one thing in this system that no rule can do:
 * deciding, from a single demonstration, which of the values a human typed are
 * *parameters* of the workflow and which are *part of its definition*.
 *
 * A macro recorder replays `inc-2026-10-05-payments` forever. Knowing that the
 * channel name varies while "private" does not is a judgment about what the
 * workflow is FOR — and the narration is usually where that judgment is
 * available, which is why spoken asides are fused in rather than transcribed
 * and discarded.
 */

import type { Trace, TraceEvent } from "@intentlink/schema";

/** What the model is asked to return. Mirrors the IntentLink schema. */
export const RESPONSE_SCHEMA = {
  type: "object",
  required: ["title", "goal", "params", "steps"],
  properties: {
    title: { type: "string" },
    goal: { type: "string" },
    context: { type: "string" },
    params: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "type", "required", "recordedExample", "rationale"],
        properties: {
          name: { type: "string", description: "snake_case identifier" },
          type: {
            type: "string",
            enum: ["string", "number", "boolean", "email", "url", "date", "enum"],
          },
          required: { type: "boolean" },
          description: { type: "string" },
          enumValues: { type: "array", items: { type: "string" } },
          pattern: { type: "string" },
          recordedExample: {
            type: "string",
            description: "the literal value seen in the recording",
          },
          rationale: {
            type: "string",
            description: "why this varies between runs rather than being fixed",
          },
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "app", "verb", "args", "sourceEvents"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          intent: { type: "string", description: "why, often from narration" },
          app: { type: "string" },
          verb: {
            type: "string",
            description: "tool-agnostic snake_case, e.g. create_channel",
          },
          object: { type: "string" },
          args: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "kind", "value"],
              properties: {
                name: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["param", "literal"],
                  description: "param if it varies per run, literal if fixed",
                },
                value: {
                  type: "string",
                  description: "parameter name when kind=param, else the constant",
                },
                rationale: { type: "string" },
              },
            },
          },
          dependsOn: { type: "array", items: { type: "string" } },
          optional: { type: "boolean" },
          condition: {
            type: "string",
            description:
              "plain-language branch when the step only applies sometimes",
          },
          sourceEvents: {
            type: "array",
            items: { type: "number" },
            description: "seq numbers this step was derived from",
          },
        },
      },
    },
    outcomes: {
      type: "array",
      items: {
        type: "object",
        required: ["describe"],
        properties: {
          describe: { type: "string" },
          textContains: { type: "string" },
        },
      },
    },
  },
} as const;

export const SYSTEM_INSTRUCTION = `
You compile a recorded demonstration into a reusable, parameterized workflow.

You are NOT transcribing clicks. You are recovering the INTENT behind them, so
that someone else's agent can achieve the same outcome in a different account,
a differently-configured UI, or another language.

THE CENTRAL JUDGMENT — parameters vs constants

For every value the human typed or chose, decide which it is:

* PARAMETER — varies between runs. It identifies this particular instance of
  the work: an incident slug, a customer name, a date, an amount.
* LITERAL — part of the workflow's definition. It encodes how this team does
  this task, and changing it would make it a different workflow: a visibility
  setting of "private", a board key of "INC", a fixed settings profile.

The test is not "does this look like data?" It is: if a colleague ran this
workflow next week for a different case, would this value change?

Be careful with values that look variable but are not. A severity of "sev2"
recorded once may be a parameter; a priority of "Highest" chosen BECAUSE the
severity was sev2 is a derived constant, and belongs in a condition rather than
as a free parameter.

NARRATION IS EVIDENCE

Spoken asides carry the reasoning the clicks cannot. "Always make it private
first" means the visibility is a LITERAL and the step is ordered. "Priority is
highest for a sev2" means the priority step carries a CONDITION on severity,
inferred from a single observation. Use narration to justify your choices, and
quote it in the step's intent when it explains one.

SEMANTIC VERBS

Emit tool-agnostic snake_case verbs — create_channel, set_setting, create_issue
— never tool names, URLs, API methods or UI labels. The same workflow must be
executable through a different UI or an API, and the policy engine matches on
these verbs.

OTHER RULES

* Group related events into one step. Opening a dialog, filling three fields
  and submitting is ONE step, not five.
* But do NOT merge actions a boundary might need to govern separately. Setting
  a channel's visibility is its own step even though it happens in the same
  dialog as creating the channel, because a creator may want to permit one and
  forbid the other. Over-merging silently removes the seams policy attaches to.
  Observed failure: a model that collapsed this workflow into two steps lost
  the visibility constant, the board key and the severity condition with them.
* dependsOn captures real ordering constraints, not merely observed sequence.
* Skip events that achieved nothing: stray clicks, navigation that was undone,
  a field filled then cleared.
* Never invent a step that is not supported by the events.
* A value that was redacted must never be reconstructed. Treat it as a required
  parameter the receiver must supply.
* Give every parameter a rationale. It is shown to the creator for review, and
  a parameter you cannot justify is probably a literal.
`.trim();

/**
 * Serialize a trace for the model.
 *
 * Deliberately compact and readable rather than raw JSON: the model reasons
 * better over a transcript than over nested objects, and every token spent on
 * punctuation is one not spent on the page's actual content.
 */
export function renderTrace(trace: Trace): string {
  const lines: string[] = [];

  lines.push(`APPS: ${trace.apps.join(" → ")}`);
  lines.push(`DURATION: ${Math.round(trace.durationMs / 1000)}s`);
  lines.push("");
  lines.push("EVENTS");

  let lastApp = "";
  let lastRoute = "";
  for (const event of trace.events) {
    const route = event.page.routeTemplate ?? event.page.path;
    if (event.page.app !== lastApp || route !== lastRoute) {
      lines.push(`  --- ${event.page.app} ${route} ---`);
      lastApp = event.page.app;
      lastRoute = route;
    }
    lines.push(`  [${event.seq}] ${describeEvent(event)}`);
  }

  if (trace.narration?.length) {
    lines.push("");
    lines.push("NARRATION (spoken while recording; the reasoning behind the clicks)");
    for (const segment of trace.narration) {
      // Anchor each remark to the events it overlaps, so the model can tie
      // "always make it private" to the toggle rather than guessing.
      const near = trace.events
        .filter((e) => e.t >= segment.startMs - 4000 && e.t <= segment.endMs + 4000)
        .map((e) => e.seq);
      const anchor = near.length ? ` (near events ${near.join(", ")})` : "";
      lines.push(`  ${JSON.stringify(segment.text)}${anchor}`);
    }
  }

  if (trace.sourceDoc) {
    lines.push("");
    lines.push("EXISTING WRITTEN INSTRUCTIONS (pasted by the creator; may be stale)");
    lines.push(trace.sourceDoc.slice(0, 8000));
  }

  return lines.join("\n");
}

function describeEvent(event: TraceEvent): string {
  const t = event.target;
  const who = t ? `${t.role} ${JSON.stringify(t.name)}` : "page";
  const where = t?.section ? ` in ${JSON.stringify(t.section)}` : "";

  switch (event.type) {
    case "navigate":
      return `navigate to ${event.page.routeTemplate ?? event.page.path}`;
    case "fill":
      if (event.redacted) {
        return `fill ${who}${where} with a REDACTED ${event.redactionReason ?? "sensitive"} value`;
      }
      return `fill ${who}${where} with ${JSON.stringify(event.value ?? "")}`;
    case "select":
      return `select ${JSON.stringify(event.value ?? "")} in ${who}${where}`;
    case "toggle":
      return `toggle ${who}${where} to ${t?.checked === true ? "on" : "off"}`;
    default:
      return `${event.type} ${who}${where}`;
  }
}

export function buildUserPrompt(trace: Trace): string {
  return [
    "Compile this demonstration into a reusable workflow.",
    "",
    renderTrace(trace),
  ].join("\n");
}
