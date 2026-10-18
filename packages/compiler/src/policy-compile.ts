/**
 * The policy compiler: plain English in, enforceable policy out.
 *
 * Unlike the intent compiler, this one does not fail closed on a bad result —
 * it reports. A policy that blocks the workflow's own step 4 is not invalid,
 * it is a boundary the creator wrote more broadly than they meant, and the
 * right response is to show them which sentence did it rather than silently
 * retrying until the model waters the rule down.
 *
 * The one thing it will retry is a policy it cannot even build.
 */

import type { IntentLink, Policy } from "@intentlink/schema";
import {
  POLICY_RESPONSE_SCHEMA,
  POLICY_SYSTEM_INSTRUCTION,
  buildPolicyPrompt,
} from "./policy-prompt.js";
import {
  analyze,
  buildPolicy,
  type CompiledPolicy,
  type PolicyBuildContext,
  type RawPolicy,
} from "./policy-validate.js";
import type { ModelClient } from "./compile.js";

export interface CompilePolicyOptions extends Omit<PolicyBuildContext, "intent"> {
  maxRepairs?: number;
  onAttempt?: (attempt: number, note: string) => void;
}

export async function compilePolicy(
  model: ModelClient,
  intent: IntentLink,
  boundaries: string,
  opts: CompilePolicyOptions,
): Promise<CompiledPolicy & { raw: RawPolicy; attempts: number }> {
  const maxRepairs = opts.maxRepairs ?? 1;
  let prompt = buildPolicyPrompt(intent, boundaries);
  let lastError = "";

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const text = await model.generate({
      systemInstruction: POLICY_SYSTEM_INSTRUCTION,
      prompt,
      responseSchema: POLICY_RESPONSE_SCHEMA,
    });

    let raw: RawPolicy;
    let policy: Policy;
    try {
      raw = parsePolicyJson(text);
      policy = buildPolicy(raw, { ...opts, intent, boundaries });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      opts.onAttempt?.(attempt, `unusable: ${lastError}`);
      prompt = [
        "Your previous policy could not be built. Fix this and return a",
        "complete policy:",
        `  ${lastError}`,
        "",
        buildPolicyPrompt(intent, boundaries),
      ].join("\n");
      continue;
    }

    const { bindings, diagnostics, runnable } = analyze(policy, raw, { ...opts, intent });
    opts.onAttempt?.(
      attempt,
      runnable ? "built, workflow runnable" : "built, workflow blocked by its own boundaries",
    );

    /*
     * One retry when the workflow blocks itself, and only then.
     *
     * The distinction matters. A creator CAN genuinely forbid something their
     * own workflow does, and in that case the right answer is to report it
     * rather than keep asking until the model waters the boundary down. But
     * the overwhelmingly common cause is a misread scoping phrase - "only
     * change the mode to light mode" is a constraint on an argument, and
     * reading it as "deny set_theme" blocks the step it was written to
     * protect.
     *
     * So the repair prompt names the clash and explicitly permits the model to
     * stand its ground: if the creator really did forbid the step, keep the
     * deny and declare it. A genuine conflict survives the retry.
     */
    const blocked = diagnostics.filter((d) => d.code === "step_blocked");
    if (blocked.length && attempt <= maxRepairs) {
      prompt = reconsiderPrompt(intent, boundaries, blocked);
      continue;
    }

    // Returned either way. A blocked workflow is a finding to show the
    // creator, not a failure to hide from them.
    return { policy, bindings, diagnostics, runnable, raw, attempts: attempt };
  }

  throw new Error(`could not compile a usable policy: ${lastError}`);
}

/**
 * Ask again about a self-blocking policy, without putting a thumb on the scale.
 *
 * It names which rule hit which step and reminds the model of the scoping
 * reading - but it also says plainly that keeping the deny is a legitimate
 * answer, so a creator who really did write a contradiction still gets told
 * instead of quietly overridden.
 */
function reconsiderPrompt(
  intent: IntentLink,
  boundaries: string,
  blocked: Array<{ message: string; stepId?: string; sourceText?: string }>,
): string {
  return [
    "Your policy forbids steps that this workflow performs, so it cannot run.",
    "",
    "THE CLASHES",
    ...blocked.map(
      (d) =>
        `  - step ${d.stepId ?? "?"} is blocked by ${JSON.stringify(d.sourceText ?? "a rule you wrote")}`,
    ),
    "",
    "Re-read those sentences. A phrase like \"only change X\" or \"don't touch",
    "anything else\" is a CONSTRAINT: it permits the step and restricts its",
    "arguments, or forbids things outside the workflow. It does not forbid the",
    "step itself.",
    "",
    "If, after re-reading, the creator genuinely did forbid something their own",
    "workflow does, keep the deny rule and put that sentence in",
    "unmatchedClauses with a note that it conflicts with the workflow. Do not",
    "weaken a boundary the creator meant.",
    "",
    buildPolicyPrompt(intent, boundaries),
  ].join("\n");
}

export function parsePolicyJson(text: string): RawPolicy {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as RawPolicy;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.rules)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error("model response did not contain a usable policy object");
}

/**
 * Render the compilation for a human.
 *
 * This is the review screen in text form: the creator's sentence, what it
 * became, and what it touches. Shipping it as a function rather than only as
 * UI means the same explanation is available in tests, in the CLI and in the
 * audit trail, and cannot drift between them.
 */
export function explain(compiled: CompiledPolicy): string {
  const lines: string[] = [];

  lines.push("WHAT YOUR BOUNDARIES BECAME");
  for (const binding of compiled.bindings) {
    const verb = binding.kind.toUpperCase().padEnd(8);
    lines.push(`  ${verb} ${JSON.stringify(binding.sourceText)}`);
    lines.push(`           ${binding.ruleIds.join(", ")}  ${binding.reasoning}`);
    if (binding.boundSteps.length) {
      lines.push(`           applies to: ${binding.boundSteps.join(", ")}`);
    }
  }

  if (compiled.diagnostics.length) {
    lines.push("");
    lines.push("WORTH YOUR ATTENTION");
    for (const d of compiled.diagnostics) {
      lines.push(`  ${d.severity === "error" ? "!" : "·"} ${d.message}`);
    }
  }

  lines.push("");
  lines.push(
    compiled.runnable
      ? "The workflow can run under these boundaries."
      : "The workflow CANNOT run under these boundaries as written.",
  );
  return lines.join("\n");
}
