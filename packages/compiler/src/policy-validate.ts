/**
 * Validating a compiled policy, and explaining it back to the creator.
 *
 * The important trick here: coverage is checked by running the REAL policy
 * engine over the workflow's own steps. Re-implementing "would this be
 * allowed?" in the compiler would create a second answer to the same question,
 * and the two would drift — the review screen would promise one thing and
 * execution would do another. Instead we simulate.
 *
 * That also makes the diagnostics honest. "Your boundary blocks step 4" is not
 * a guess about what might happen; it is what the engine actually returns.
 */

import {
  Policy,
  type ActionRule,
  type ApprovalRule,
  type ArgConstraint,
  type IntentLink,
  type ProposedAction,
  type Step,
} from "@intentlink/schema";
import { evaluate, type EvalContext } from "@intentlink/policy";

/* ------------------------------ model output ------------------------------ */

export interface RawPolicyRule {
  sourceText: string;
  kind: "allow" | "deny" | "approval";
  verb: string;
  object?: string;
  args?: Array<{ arg: string; op: ArgConstraint["op"]; value: string }>;
  route?: "receiver" | "creator" | "two_party";
  requireJustification?: boolean;
  boundSteps: string[];
  reasoning: string;
}

export interface RawPolicy {
  rules: RawPolicyRule[];
  scope?: {
    origins?: string[];
    paths?: string[];
    resources?: string[];
    dataExclusions?: string[];
  };
  limits?: {
    numeric?: Array<{ arg: string; op: ArgConstraint["op"]; value: string }>;
    maxActions?: number;
    maxExecutions?: number;
    rateLimit?: number;
  };
  expiryHours?: number;
  receivers?: string[];
  unmatchedClauses?: string[];
}

/* -------------------------------- bindings -------------------------------- */

/** What one of the creator's sentences actually became. */
export interface Binding {
  sourceText: string;
  kind: "allow" | "deny" | "approval";
  ruleIds: string[];
  /** Steps of this workflow the rule applies to, as the engine sees it. */
  boundSteps: string[];
  reasoning: string;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code:
    | "step_blocked"
    | "step_uncovered"
    | "step_needs_approval"
    | "overbroad_allow"
    | "unmatched_clause"
    | "self_approval"
    | "no_expiry";
  message: string;
  stepId?: string;
  ruleId?: string;
  sourceText?: string;
}

export interface CompiledPolicy {
  policy: Policy;
  bindings: Binding[];
  diagnostics: Diagnostic[];
  /** True when every step would be permitted or approvable as written. */
  runnable: boolean;
}

/* -------------------------------- building -------------------------------- */

export interface PolicyBuildContext {
  intent: IntentLink;
  policyId: string;
  /** app -> origin, so scope rules are simulated against real origins. */
  origins?: Record<string, string>;
  now?: Date;
}

function constraintsFrom(
  args: Array<{ arg: string; op: ArgConstraint["op"]; value: string }> | undefined,
): ArgConstraint[] {
  return (args ?? []).map((a) => ({
    arg: a.arg,
    op: a.op,
    // Numbers and lists arrive as strings from the model; the engine compares
    // numerically for lt/lte/gt/gte and by membership for in/not_in, so they
    // have to be real values rather than their string spellings.
    value: coerceConstraintValue(a.op, a.value),
  }));
}

function coerceConstraintValue(
  op: ArgConstraint["op"],
  value: string,
): ArgConstraint["value"] {
  if (op === "in" || op === "not_in") {
    return value
      .split(",")
      .map((v) => v.trim().replace(/^[[\]"']+|[[\]"']+$/g, ""))
      .filter(Boolean);
  }
  if (["lt", "lte", "gt", "gte"].includes(op) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return value;
}

export function buildPolicy(raw: RawPolicy, ctx: PolicyBuildContext): Policy {
  const allowed: ActionRule[] = [];
  const denied: ActionRule[] = [];
  const approvalRequired: ApprovalRule[] = [];

  raw.rules.forEach((rule, index) => {
    const base: ActionRule = {
      id: `${rule.kind[0]}${index + 1}`,
      verb: rule.verb,
      args: constraintsFrom(rule.args),
      sourceText: rule.sourceText,
      boundSteps: rule.boundSteps ?? [],
    };
    if (rule.object) base.object = rule.object;

    if (rule.kind === "deny") denied.push(base);
    else if (rule.kind === "allow") allowed.push(base);
    else {
      approvalRequired.push({
        ...base,
        // "Ask me" means the creator decides. Defaulting to the receiver would
        // let whoever runs the workflow approve their own action.
        route: rule.route ?? "creator",
        requireJustification: rule.requireJustification ?? false,
        grantTtlSeconds: 120,
      });
    }
  });

  /*
   * Reading the current page is how the agent perceives anything, and no
   * creator writes "you may look at the screen". Without this every policy
   * denies observation by default and the workflow cannot start. Scope rules
   * still apply: the policy's origins and paths bound WHERE it may look.
   */
  if (!allowed.some((r) => r.verb === "read_page" || r.verb === "*")) {
    allowed.push({
      id: "a0",
      verb: "read_page",
      args: [],
      sourceText: "implicit: the agent may observe the pages it is scoped to",
      boundSteps: [],
    });
  }

  const now = ctx.now ?? new Date();
  const expiryHours = raw.expiryHours && raw.expiryHours > 0 ? raw.expiryHours : 24;

  return Policy.parse({
    id: ctx.policyId,
    intentId: ctx.intent.id,
    version: 1,
    scope: {
      origins: raw.scope?.origins ?? [],
      paths: raw.scope?.paths ?? [],
      resources: raw.scope?.resources ?? [],
      dataExclusions: raw.scope?.dataExclusions ?? [],
    },
    allowed,
    denied,
    approvalRequired,
    limits: {
      numeric: constraintsFrom(raw.limits?.numeric),
      maxActions: raw.limits?.maxActions ?? 200,
      maxExecutions: raw.limits?.maxExecutions ?? 1,
      rateLimit: raw.limits?.rateLimit ?? 60,
      maxNavigationHops: 5,
    },
    expiresAt: new Date(now.getTime() + expiryHours * 3600_000).toISOString(),
    receivers: raw.receivers ?? [],
    destructiveVerbs: [],
    allowTypedLiterals: true,
    mode: "live",
  });
}

/* ------------------------------- simulation ------------------------------- */

/**
 * Turn a compiled step into the action the agent would actually propose, with
 * parameters standing in at their recorded values. This is what the engine
 * will see at run time, so coverage checked against it is coverage for real.
 */
export function actionForStep(
  step: Step,
  intent: IntentLink,
  origins: Record<string, string> = {},
): ProposedAction {
  const args: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(step.action.args)) {
    if ("literal" in value) {
      args[name] = value.literal;
      continue;
    }
    const param = intent.params.find((p) => p.name === value.param);
    args[name] = param?.recordedExample ?? param?.default ?? `<${value.param}>`;
  }

  const action: ProposedAction = {
    executionId: "00000000-0000-4000-8000-000000000000",
    stepId: step.id,
    verb: step.action.verb,
    args,
  };
  if (step.action.object !== undefined) action.object = step.action.object;
  const origin = origins[step.app];
  if (origin) action.origin = origin;
  return action;
}

export function analyze(
  policy: Policy,
  raw: RawPolicy,
  ctx: PolicyBuildContext,
): { bindings: Binding[]; diagnostics: Diagnostic[]; runnable: boolean } {
  const diagnostics: Diagnostic[] = [];
  const now = ctx.now ?? new Date();

  /*
   * Simulate with every budget wide open and the receiver assumed valid. We
   * are asking "do the RULES permit this workflow", not "would this particular
   * run hit a rate limit", so anything that depends on run-time counters would
   * only produce noise in a review screen.
   */
  const evalCtx: EvalContext = {
    now,
    receiver: policy.receivers[0] ?? "receiver@example.com",
    actionsUsed: 0,
    actionsInLastMinute: 0,
    executionsUsed: 0,
  };

  let runnable = true;

  for (const step of ctx.intent.steps) {
    const action = actionForStep(step, ctx.intent, ctx.origins);
    const decision = evaluate(policy, action, evalCtx);

    if (decision.outcome === "DENY") {
      // The creator has forbidden something their own workflow does. Almost
      // always a boundary that was meant more narrowly than it was written.
      runnable = false;
      diagnostics.push({
        severity: "error",
        code: decision.ruleId ? "step_blocked" : "step_uncovered",
        stepId: step.id,
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        ...(decision.sourceText ? { sourceText: decision.sourceText } : {}),
        message: decision.ruleId
          ? `"${step.title}" is blocked by your boundary ${JSON.stringify(decision.sourceText ?? decision.ruleId)}. The workflow cannot complete as written.`
          : `"${step.title}" is not permitted by any rule, so it would be denied by default. Allow ${step.action.verb} or remove the step.`,
      });
    } else if (decision.outcome === "APPROVAL") {
      diagnostics.push({
        severity: "warning",
        code: "step_needs_approval",
        stepId: step.id,
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        ...(decision.sourceText ? { sourceText: decision.sourceText } : {}),
        message: `"${step.title}" will pause for approval every run.`,
      });
    }
  }

  for (const rule of policy.allowed) {
    if (rule.verb === "*" || rule.verb === "*_*") {
      diagnostics.push({
        severity: "warning",
        code: "overbroad_allow",
        ruleId: rule.id,
        ...(rule.sourceText ? { sourceText: rule.sourceText } : {}),
        message: `Rule ${rule.id} permits every action. Narrow it to the verbs this workflow needs.`,
      });
    }
  }

  for (const rule of policy.approvalRequired) {
    if (rule.route === "receiver" && /\bask me\b|\bmy approval\b|\bcheck with me\b/i.test(rule.sourceText ?? "")) {
      diagnostics.push({
        severity: "warning",
        code: "self_approval",
        ruleId: rule.id,
        sourceText: rule.sourceText ?? "",
        message: `You asked to be consulted, but this approval goes to whoever runs the workflow, who could approve it themselves.`,
      });
    }
  }

  for (const clause of raw.unmatchedClauses ?? []) {
    // A boundary silently dropped is worse than one the creator is told about:
    // they believe they are protected and they are not.
    diagnostics.push({
      severity: "error",
      code: "unmatched_clause",
      sourceText: clause,
      message: `Could not turn ${JSON.stringify(clause)} into an enforceable rule. It will NOT be applied.`,
    });
  }

  const bindings: Binding[] = raw.rules.map((rule, index) => ({
    sourceText: rule.sourceText,
    kind: rule.kind,
    ruleIds: [`${rule.kind[0]}${index + 1}`],
    boundSteps: rule.boundSteps ?? [],
    reasoning: rule.reasoning,
  }));

  return { bindings, diagnostics, runnable };
}
