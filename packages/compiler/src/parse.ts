/**
 * Turning a model response into a validated IntentLink.
 *
 * The model call is one line. This file is where the engineering is, because a
 * plausible-looking compilation that is subtly wrong is far more dangerous than
 * one that fails loudly: it becomes a shareable artifact that someone else's
 * agent executes against their real systems.
 *
 * Every check here exists because the failure it catches would otherwise be
 * invisible until run time, in someone else's browser.
 */

import {
  IntentLink,
  type ArgValue,
  type Assertion,
  type Parameter,
  type Step,
  type Trace,
} from "@intentlink/schema";

/* ------------------------------ model output ------------------------------ */

export interface RawArg {
  name: string;
  kind: "param" | "literal";
  value: string;
  rationale?: string;
}

export interface RawStep {
  id: string;
  title: string;
  intent?: string;
  app: string;
  verb: string;
  object?: string;
  args: RawArg[];
  dependsOn?: string[];
  optional?: boolean;
  condition?: string;
  sourceEvents: number[];
}

export interface RawParam {
  name: string;
  type: Parameter["type"];
  required: boolean;
  description?: string;
  enumValues?: string[];
  pattern?: string;
  recordedExample: string;
  rationale: string;
}

export interface RawCompilation {
  title: string;
  goal: string;
  context?: string;
  params: RawParam[];
  steps: RawStep[];
  outcomes?: Array<{ describe: string; textContains?: string }>;
}

export class CompilationError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "CompilationError";
  }
}

/* -------------------------------- helpers --------------------------------- */

/** Every non-redacted value the human actually typed or selected. */
export function observedValues(trace: Trace): Set<string> {
  const values = new Set<string>();
  for (const event of trace.events) {
    if (event.redacted || event.value === undefined) continue;
    values.add(event.value);
    // Models routinely normalise whitespace or case when echoing a value back;
    // that is a faithful quote of what was demonstrated, not an invention.
    values.add(event.value.trim());
    values.add(event.value.trim().toLowerCase());
  }
  return values;
}

/**
 * What a specific step's events can justify.
 *
 * Typed values alone are too narrow a notion of evidence. A legitimate
 * constant is frequently never typed at all:
 *
 *   "private" comes from toggling a switch LABELLED "Make private"
 *   "INC"     comes from the route /jira/software/projects/INC/boards/12
 *
 * Both are plainly demonstrated; neither appears in any event's `value`.
 * Scoping evidence to the events a step actually cites keeps the check tight
 * — the model can only draw on what was on screen during THAT step — while
 * admitting constants the recording genuinely supports.
 */
export function evidenceFor(trace: Trace, sourceEvents: number[]): Set<string> {
  const evidence = new Set<string>();
  const add = (text: string | undefined): void => {
    if (!text) return;
    const clean = text.trim().toLowerCase();
    if (!clean) return;
    evidence.add(clean);
    // Individual words, so "Make private" justifies "private" but a value
    // assembled from words that were never on screen still fails.
    for (const word of clean.split(/[^a-z0-9]+/)) {
      if (word.length >= 2) evidence.add(word);
    }
  };

  const cited = new Set(sourceEvents);
  for (const event of trace.events) {
    if (!cited.has(event.seq)) continue;

    if (!event.redacted) add(event.value);

    for (const segment of event.page.path.split("/")) add(segment);
    add(event.target?.name);
    add(event.target?.section);

    if (event.target?.checked !== undefined) {
      add(String(event.target.checked));
      add(event.target.checked === true ? "on" : "off");
    }
  }
  return evidence;
}

/** Event seqs whose value was withheld by redaction. */
export function redactedSeqs(trace: Trace): Set<number> {
  return new Set(
    trace.events.filter((e) => e.redacted).map((e) => e.seq),
  );
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

/** Shapes that mean the model emitted a tool call rather than an intent. */
const TOOL_SHAPED = [
  /\./, // pubsub.topics.create
  /^(get|post|put|patch|delete)_/i, // HTTP verbs
  /^https?/i,
  /[A-Z]/, // camelCase or PascalCase
  /\//,
];

/* ------------------------------- validation ------------------------------- */

export interface ValidationContext {
  trace: Trace;
  intentId: string;
  policyId: string;
  createdBy: string;
  now?: Date;
}

/**
 * Validate and convert. Collects every problem rather than throwing on the
 * first, because a repair prompt that fixes one issue at a time costs a
 * round trip per problem.
 */
export function toIntentLink(raw: RawCompilation, ctx: ValidationContext): IntentLink {
  const problems: string[] = [];

  const declared = new Set(raw.params.map((p) => p.name));
  const stepIds = new Set(raw.steps.map((s) => s.id));
  const validSeqs = new Set(ctx.trace.events.map((e) => e.seq));

  for (const param of raw.params) {
    if (!SNAKE.test(param.name)) {
      problems.push(`parameter "${param.name}" is not snake_case`);
    }
    if (!param.rationale?.trim()) {
      // A parameter the model cannot justify is usually a literal it decided
      // to make configurable, which quietly widens what the agent may type.
      problems.push(`parameter "${param.name}" has no rationale`);
    }
  }

  if (raw.params.length !== declared.size) {
    problems.push("duplicate parameter names");
  }
  if (raw.steps.length !== stepIds.size) {
    problems.push("duplicate step ids");
  }

  for (const step of raw.steps) {
    if (!SNAKE.test(step.verb)) {
      problems.push(`step ${step.id}: verb "${step.verb}" is not snake_case`);
    }
    if (TOOL_SHAPED.some((re) => re.test(step.verb))) {
      problems.push(
        `step ${step.id}: verb "${step.verb}" looks like a tool call, not a semantic intent`,
      );
    }

    for (const seq of step.sourceEvents) {
      if (!validSeqs.has(seq)) {
        problems.push(`step ${step.id}: cites event ${seq}, which is not in the trace`);
      }
    }
    if (step.sourceEvents.length === 0) {
      // A step grounded in no event is a step the model invented.
      problems.push(`step ${step.id}: cites no source events`);
    }

    /*
     * A step whose events carry no element is a step with nothing to act on.
     * The executor resolves against the recorded descriptors, and with none
     * of them every candidate scores zero - so the step can never match
     * anything, on any page, and the run reports that nothing was done
     * without ever saying why.
     *
     * Usually it means the model built a step out of a navigation.
     */
    const citesAnElement = step.sourceEvents.some((seq) =>
      ctx.trace.events.some((e) => e.seq === seq && e.target),
    );
    if (!citesAnElement && step.sourceEvents.length > 0) {
      problems.push(
        `step ${step.id}: cites only events with no element (${step.sourceEvents.join(", ")}), so there is nothing to act on`,
      );
    }

    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        problems.push(`step ${step.id}: depends on unknown step "${dep}"`);
      }
    }

    const evidence = evidenceFor(ctx.trace, step.sourceEvents);

    for (const arg of step.args) {
      if (arg.kind === "param") {
        if (!declared.has(arg.value)) {
          problems.push(
            `step ${step.id}: argument "${arg.name}" uses undeclared parameter "${arg.value}"`,
          );
        }
        continue;
      }

      /*
       * A literal becomes part of the typed-value allowlist the policy engine
       * enforces at run time, so a hallucinated literal is the agent being
       * granted permission to use something no human ever demonstrated.
       * Booleans and numbers are excused: they are states the model reads off
       * a toggle rather than values quoted from the page.
       *
       * This check also subsumes redaction, which is why there is no separate
       * rule for it. evidenceFor() never admits a redacted event's VALUE, so a
       * reconstructed secret cannot be evidenced and is rejected here.
       *
       * An earlier version banned every literal on any step that merely CITED
       * a redacted event. Real models failed it repeatedly and were right to:
       * create_issue legitimately groups the summary, the board key INC, and
       * the redacted assignee, and a step-level ban rejected INC for the
       * company its event kept. The restriction belongs on the value, not the
       * step.
       */
      const value = arg.value;
      const structural = /^(true|false|on|off|-?\d+(\.\d+)?)$/i.test(value);
      if (!structural && !evidence.has(value.trim().toLowerCase())) {
        problems.push(
          `step ${step.id}: literal ${JSON.stringify(value)} for "${arg.name}" is not evidenced by the events this step cites`,
        );
      }


    }
  }

  const cycle = findCycle(raw.steps);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" → ")}`);

  if (problems.length) {
    throw new CompilationError(
      `compilation failed ${problems.length} check(s)`,
      problems,
    );
  }

  const params: Parameter[] = raw.params.map((p) => {
    const param: Parameter = {
      name: p.name,
      type: p.type,
      required: p.required,
      recordedExample: p.recordedExample,
    };
    if (p.description) param.description = p.description;
    if (p.enumValues?.length) param.enumValues = p.enumValues;
    if (p.pattern) param.pattern = p.pattern;
    return param;
  });

  const steps: Step[] = raw.steps.map((s) => {
    const args: Record<string, ArgValue> = {};
    for (const arg of s.args) {
      args[arg.name] =
        arg.kind === "param" ? { param: arg.value } : { literal: coerce(arg.value) };
    }

    const step: Step = {
      id: s.id,
      title: s.title,
      app: s.app,
      action: { verb: s.verb, args },
      hints: hintsFor(ctx.trace, s.sourceEvents),
      learnedHints: [],
      dependsOn: s.dependsOn ?? [],
      optional: s.optional ?? false,
      pre: [],
      post: [],
    };
    if (s.intent) step.intent = s.intent;
    if (s.object) step.action.object = s.object;
    if (s.condition) step.condition = s.condition;
    return step;
  });

  const outcomes: Assertion[] = (raw.outcomes ?? []).map((o) => ({
    describe: o.describe,
    expect: o.textContains ? { textContains: o.textContains } : { exists: true },
  }));

  const intent: IntentLink = {
    id: ctx.intentId,
    version: 1,
    title: raw.title,
    goal: raw.goal,
    params,
    steps,
    outcomes,
    policyId: ctx.policyId,
    traceId: ctx.trace.traceId,
    status: "draft",
    createdBy: ctx.createdBy,
    createdAt: (ctx.now ?? new Date()).toISOString(),
  };
  if (raw.context) intent.context = raw.context;

  // Final gate: the schema is the contract every other track integrates
  // against, so nothing leaves here that it would reject.
  return IntentLink.parse(intent);
}

/**
 * Resolution hints come from the TRACE, never from the model.
 *
 * The model's job is intent; descriptors are evidence. Letting it emit
 * descriptors would let it hallucinate an element that was never on the page,
 * and the executor would then hunt for something that does not exist.
 */
function hintsFor(trace: Trace, sourceEvents: number[]): Step["hints"] {
  const hints = [];
  for (const seq of sourceEvents) {
    const event = trace.events.find((e) => e.seq === seq);
    if (event?.target) hints.push(event.target);
  }
  return hints.slice(0, 8);
}

function coerce(value: string): string | number | boolean {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function findCycle(steps: RawStep[]): string[] | undefined {
  const graph = new Map(steps.map((s) => [s.id, s.dependsOn ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const current = state.get(id);
    if (current === "done") return undefined;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, "visiting");
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return undefined;
}
