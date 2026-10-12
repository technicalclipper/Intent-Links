/**
 * The full creator path, end to end, against real Gemini.
 *
 * Recording -> parameterized workflow -> English boundaries -> enforceable
 * policy -> a review of what those boundaries actually became.
 *
 * This is the pipeline behind the demo's first ninety seconds, runnable from a
 * terminal so it can be rehearsed and debugged without the extension or the UI
 * existing yet.
 *
 * Usage: node --env-file-if-exists=../../.env scripts/demo.mjs
 */

import { readFileSync } from "node:fs";
import { Trace } from "@intentlink/schema";
import { compileIntent, compilePolicy, explain, geminiClient } from "../dist/index.js";

const trace = Trace.parse(
  JSON.parse(
    readFileSync(new URL("../../schema/fixtures/trace.slack-jira.json", import.meta.url), "utf8"),
  ),
);

const BOUNDARIES = `
Run the incident setup, but don't invite anyone outside the company, never post
in #general, and don't delete anything. Ask me before paging anyone externally.
Valid for 24 hours, one run only.
`.trim();

const rule = (s) => console.log("\n" + "=".repeat(70) + "\n" + s + "\n" + "=".repeat(70));

const model = geminiClient({
  onRetry: (n, msg) => console.log(`  (retry ${n}: ${msg.slice(0, 50)}…)`),
  onFallback: (from, to) => console.log(`  (${from} unavailable → falling back to ${to})`),
  onQuota: (m) => console.log(`  (${m} daily quota exhausted → next model in the chain)`),
});

rule("1. COMPILE THE DEMONSTRATION");
const { intent, attempts } = await compileIntent(model, trace, {
  intentId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  createdBy: "sre-lead@acme.com",
  maxRepairs: 2,
  onAttempt: (n, problems) =>
    console.log(`  attempt ${n}: ${problems.length ? problems.join("; ") : "accepted"}`),
});

console.log(`\n  ${intent.steps.length} steps, ${intent.params.length} parameters, ${attempts} attempt(s)\n`);

console.log("  PARAMETERS — what varies between runs");
for (const p of intent.params) {
  console.log(`    ${p.name.padEnd(18)} ${String(p.type).padEnd(8)} e.g. ${JSON.stringify(p.recordedExample ?? "")}`);
}

console.log("\n  STEPS — constants are part of the workflow's definition");
for (const s of intent.steps) {
  const args = Object.entries(s.action.args)
    .map(([k, v]) => ("param" in v ? `${k}=<${v.param}>` : `${k}=${JSON.stringify(v.literal)}`))
    .join(" ");
  console.log(`    ${s.id}  ${s.action.verb.padEnd(16)} ${args}`);
  if (s.condition) console.log(`         only when: ${s.condition}`);
}

rule("2. COMPILE THE BOUNDARIES");
console.log(`\n  The creator typed:\n`);
for (const line of BOUNDARIES.split("\n")) console.log(`    ${line}`);
console.log();

const compiled = await compilePolicy(model, intent, BOUNDARIES, {
  policyId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  origins: { slack: "https://acme.slack.com", jira: "https://acme.atlassian.net" },
  onAttempt: (n, note) => console.log(`  attempt ${n}: ${note}`),
});

rule("3. WHAT THOSE WORDS BECAME");
console.log();
console.log(explain(compiled));

console.log("\n  Machine-enforceable form:");
console.log(`    allowed:  ${compiled.policy.allowed.map((r) => r.verb).join(", ")}`);
console.log(`    denied:   ${compiled.policy.denied.map((r) => r.verb).join(", ")}`);
console.log(`    approval: ${compiled.policy.approvalRequired.map((r) => `${r.verb} -> ${r.route}`).join(", ")}`);
console.log(`    expires:  ${compiled.policy.expiresAt}`);
console.log(`    runs:     ${compiled.policy.limits.maxExecutions}`);
