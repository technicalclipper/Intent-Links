/**
 * The policy engine.
 *
 * A pure function: (policy, proposedAction, context) -> Decision. No I/O, no
 * model, no clock of its own — `now` is passed in so every decision is
 * reproducible and testable. This is the final gate before any action reaches
 * the world, and the only component permitted to say yes.
 *
 * Order of evaluation is itself a security property. Lifecycle and scope are
 * checked before rules, DENY is checked before APPROVAL, APPROVAL before
 * ALLOW, and anything unmatched is denied. There is no path to ALLOW that
 * skips a deny rule.
 */

import {
  DEFAULT_DESTRUCTIVE_VERBS,
  type ApprovalRule,
  type Decision,
  type Policy,
  type ProposedAction,
} from "@intentlink/schema";
import { argConstraintHolds, globMatch, mostSpecific, ruleMatches, type ArgMap } from "./match.js";

export interface EvalContext {
  /** Injected so decisions are deterministic under test. */
  now: Date;
  /** Identity of whoever opened the link, if known. */
  receiver?: string;
  /** Actions already taken in this execution — against limits.maxActions. */
  actionsUsed?: number;
  /** Actions in the trailing 60s — against limits.rateLimit. */
  actionsInLastMinute?: number;
  /** Completed executions of this IntentLink — against limits.maxExecutions. */
  executionsUsed?: number;
  /**
   * Values the agent is permitted to type: the receiver-supplied parameters
   * plus literals compiled from the recording. An agent may not invent a
   * string to put in a field, which removes a whole class of browser-agent
   * risk in one check.
   */
  allowedValues?: Array<string | number | boolean>;
  /** Hash the execution was pinned to at start. Mismatch means tampering. */
  pinnedPolicyHash?: string;
}

const deny = (reason: string, extra: Partial<Decision> = {}): Decision => ({
  outcome: "DENY",
  reason,
  ...extra,
});

/** Receiver allowlist entries are either a full address or an "@domain". */
function receiverAllowed(policy: Policy, receiver: string | undefined): boolean {
  if (policy.receivers.length === 0) return true;
  if (!receiver) return false;
  const who = receiver.toLowerCase();
  return policy.receivers.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith("@") ? who.endsWith(e) : who === e;
  });
}

function withinTimeWindow(policy: Policy, now: Date): boolean {
  if (policy.timeWindows.length === 0) return true;
  return policy.timeWindows.some((w) => {
    // Resolve the wall-clock day and minute in the window's own zone.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: w.tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const minute = Number(get("hour")) * 60 + Number(get("minute"));
    if (!w.days.includes(dayIndex)) return false;
    return minute >= w.startMinute && minute <= w.endMinute;
  });
}

function inScope(policy: Policy, action: ProposedAction): string | undefined {
  const { origins, paths } = policy.scope;
  if (origins.length && action.origin !== undefined) {
    if (!origins.some((o) => globMatch(o, action.origin))) {
      return `${action.origin} is outside the origins this IntentLink may touch`;
    }
  }
  if (paths.length && action.path !== undefined) {
    if (!paths.some((p) => globMatch(p, action.path))) {
      return `${action.path} is outside the paths this IntentLink may touch`;
    }
  }
  return undefined;
}

/**
 * Deny-by-default for irreversible verbs, plus the browser-side net: a control
 * whose accessible name reads destructive ("Delete project") is treated as
 * destructive even when the proposed verb looks benign. Policy authors cannot
 * be expected to anticipate every wording; this catches what they missed.
 */
function destructiveHit(policy: Policy, action: ProposedAction): string | undefined {
  const verbs = [...DEFAULT_DESTRUCTIVE_VERBS, ...policy.destructiveVerbs];
  const verb = action.verb.toLowerCase();
  if (verbs.some((v) => verb === v || verb.startsWith(`${v}_`))) {
    return `"${action.verb}" is an irreversible action`;
  }
  const name = action.targetName?.toLowerCase();
  if (name) {
    const hit = verbs.find((v) => new RegExp(`\\b${v.replace(/_/g, "[ _]")}\\b`).test(name));
    if (hit) return `the control "${action.targetName}" performs an irreversible action`;
  }
  return undefined;
}

export function evaluate(
  policy: Policy,
  action: ProposedAction,
  ctx: EvalContext,
): Decision {
  const args: ArgMap = action.args ?? {};

  /* 1. Lifecycle ---------------------------------------------------------- */

  if (policy.revokedAt && new Date(policy.revokedAt) <= ctx.now) {
    return deny("This IntentLink was revoked by its creator.");
  }
  if (new Date(policy.expiresAt) <= ctx.now) {
    return deny("This IntentLink has expired.");
  }
  if (ctx.pinnedPolicyHash && policy.hash && ctx.pinnedPolicyHash !== policy.hash) {
    return deny(
      "The policy changed after this execution started. Nothing was done; start a new run to use the updated boundaries.",
    );
  }

  /* 2. Who, where, when --------------------------------------------------- */

  if (!receiverAllowed(policy, ctx.receiver)) {
    return deny("This IntentLink was shared with specific people, and you are not one of them.");
  }
  if (!withinTimeWindow(policy, ctx.now)) {
    return deny("This IntentLink may only run during the window its creator set.");
  }
  const scopeMiss = inScope(policy, action);
  if (scopeMiss) return deny(scopeMiss);

  /* 3. Budgets ------------------------------------------------------------ */

  if ((ctx.executionsUsed ?? 0) >= policy.limits.maxExecutions) {
    return deny(
      `This IntentLink allows ${policy.limits.maxExecutions} run(s) and has already been used.`,
    );
  }
  if ((ctx.actionsUsed ?? 0) >= policy.limits.maxActions) {
    return deny(`This run reached its ceiling of ${policy.limits.maxActions} actions.`);
  }
  if ((ctx.actionsInLastMinute ?? 0) >= policy.limits.rateLimit) {
    return deny(`Rate limit reached: ${policy.limits.rateLimit} actions per minute.`);
  }

  /* 4. Values the agent may type ------------------------------------------ */

  if (ctx.allowedValues) {
    const permitted = new Set(ctx.allowedValues.map((v) => String(v)));
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "boolean") continue;
      if (!permitted.has(String(value))) {
        return deny(
          `The agent tried to supply a value for "${key}" that came from neither your parameters nor the recording.`,
          { suggestion: "Values must originate from a declared parameter or the original demonstration." },
        );
      }
    }
  }

  /* 5. Explicit denials win over everything ------------------------------- */

  const denials = policy.denied.filter((r) => ruleMatches(r, action.verb, action.object, args));
  if (denials.length) {
    const rule = mostSpecific(denials)!;
    return deny(
      rule.sourceText
        ? `Blocked by your boundary: "${rule.sourceText}"`
        : `Blocked: ${action.verb} is not permitted by this IntentLink.`,
      { ruleId: rule.id, sourceText: rule.sourceText },
    );
  }

  /* 6. Numeric ceilings ---------------------------------------------------- */

  for (const c of policy.limits.numeric) {
    if (c.arg in args && !argConstraintHolds(c, args)) {
      return deny(
        `${c.arg} is ${String(args[c.arg])}, which exceeds the limit set for this IntentLink (${c.op} ${String(c.value)}).`,
        { suggestion: `Use a ${c.arg} within the permitted range.` },
      );
    }
  }

  /* 7. Is this action permitted at all? ------------------------------------ */

  const allows = policy.allowed.filter((r) => ruleMatches(r, action.verb, action.object, args));
  const approvals = policy.approvalRequired.filter((r) =>
    ruleMatches(r, action.verb, action.object, args),
  );

  /*
   * The destructive net exists to catch what the creator never contemplated.
   * Gating it on allows alone was wrong: "ask me before paging anyone" IS the
   * creator contemplating a destructive action, so an approval rule counts as
   * acknowledgment just as much as an allow rule does. Without this, every
   * approval rule over a destructive verb was unreachable.
   */
  const destructive = destructiveHit(policy, action);
  if (destructive && allows.length === 0 && approvals.length === 0) {
    return deny(
      `Blocked because ${destructive} and this IntentLink never granted it.`,
      {
        suggestion:
          "Irreversible actions are denied unless the creator allowed them explicitly, even if no rule mentions them.",
      },
    );
  }

  /* 8. Approval ------------------------------------------------------------ */

  if (approvals.length) {
    const rule = mostSpecific(approvals) as ApprovalRule;
    return {
      outcome: "APPROVAL",
      ruleId: rule.id,
      sourceText: rule.sourceText,
      approvalRoute: rule.route,
      reason: rule.sourceText
        ? `Needs approval because you asked: "${rule.sourceText}"`
        : `${action.verb} needs approval before it can run.`,
    };
  }

  /* 9. Allow, or deny by default ------------------------------------------- */

  if (allows.length === 0) {
    return deny(
      `${action.verb} is not among the actions this IntentLink permits.`,
      { suggestion: "Nothing is allowed unless the creator allowed it." },
    );
  }

  const rule = mostSpecific(allows)!;
  return {
    outcome: "ALLOW",
    ruleId: rule.id,
    sourceText: rule.sourceText,
    reason: rule.sourceText
      ? `Permitted: "${rule.sourceText}"`
      : `Permitted by this IntentLink.`,
  };
}

/**
 * Dry run returns exactly the decision a live run would, minus any authority:
 * the plan preview must never be able to cause an effect.
 */
export function evaluateForPreview(
  policy: Policy,
  action: ProposedAction,
  ctx: EvalContext,
): Decision {
  const d = evaluate(policy, action, ctx);
  const { token: _dropped, ...rest } = d;
  return rest;
}
