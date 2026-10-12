/**
 * Pick the compile-time model on evidence.
 *
 * Runs the real compiler against candidate models and scores each on the
 * judgments that actually matter for this product — not on whether the JSON
 * parsed, but on whether it recovered the INTENT: which values vary, which are
 * team conventions, and which hide a condition.
 *
 * Usage: node --env-file-if-exists=../../.env scripts/evaluate-models.mjs
 */

import { readFileSync } from "node:fs";
import { Trace } from "@intentlink/schema";
import { compileIntent, geminiClient } from "../dist/index.js";

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-2.5-pro"];

const trace = Trace.parse(
  JSON.parse(
    readFileSync(new URL("../../schema/fixtures/trace.slack-jira.json", import.meta.url), "utf8"),
  ),
);

const CTX = {
  intentId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  createdBy: "eval@localhost",
};

/**
 * The checks are deliberately about judgment, not shape. A compilation that
 * validates but marks "private" as a parameter has missed the entire point.
 */
const CHECKS = [
  {
    name: "channel name is a PARAMETER",
    run: (i) =>
      i.steps.some((s) =>
        Object.values(s.action.args).some(
          (a) => "param" in a && /slug|name|incident/i.test(a.param),
        ),
      ),
  },
  {
    name: 'visibility "private" is a LITERAL',
    run: (i) =>
      i.steps.some((s) =>
        Object.values(s.action.args).some(
          (a) => "literal" in a && String(a.literal).toLowerCase() === "private",
        ),
      ),
  },
  {
    name: "board key INC is a LITERAL",
    run: (i) =>
      i.steps.some((s) =>
        Object.values(s.action.args).some(
          (a) => "literal" in a && String(a.literal).toUpperCase() === "INC",
        ),
      ),
  },
  {
    name: "priority carries a CONDITION on severity",
    run: (i) => i.steps.some((s) => /sev/i.test(s.condition ?? "")),
  },
  {
    name: "verbs are semantic, not tool calls",
    run: (i) => i.steps.every((s) => /^[a-z][a-z0-9_]*$/.test(s.action.verb)),
  },
  {
    name: "redacted assignee did not become a literal",
    run: (i) =>
      !i.steps.some(
        (s) =>
          /assign/i.test(s.title + (s.action.object ?? "")) &&
          Object.values(s.action.args).some((a) => "literal" in a),
      ),
  },
];

for (const model of CANDIDATES) {
  process.stdout.write(`\n${"=".repeat(64)}\n${model}\n${"=".repeat(64)}\n`);
  const started = Date.now();
  try {
    const { intent, attempts } = await compileIntent(
      geminiClient({ model }),
      trace,
      {
        ...CTX,
        maxRepairs: 2,
        onAttempt: (n, problems) =>
          problems.length
            ? console.log(`  attempt ${n}: rejected — ${problems.join("; ")}`)
            : console.log(`  attempt ${n}: accepted`),
      },
    );

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    let passed = 0;
    for (const check of CHECKS) {
      const ok = check.run(intent);
      if (ok) passed++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${check.name}`);
    }
    console.log(`  → ${passed}/${CHECKS.length} judgments, ${attempts} attempt(s), ${elapsed}s`);
    console.log(`  params: ${intent.params.map((p) => p.name).join(", ")}`);
    console.log(`  steps:  ${intent.steps.map((s) => s.action.verb).join(", ")}`);
  } catch (err) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  FAILED after ${elapsed}s: ${err.message}`);
    if (err.problems) for (const p of err.problems) console.log(`    - ${p}`);
  }
}
