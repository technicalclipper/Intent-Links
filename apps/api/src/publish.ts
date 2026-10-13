/**
 * Publishing: the step that turns a recording into a shareable link.
 *
 * This is the hinge of the whole product. Everything before it is a trace
 * sitting in a browser; everything after it is an artifact someone else's
 * agent can execute under boundaries they can read before consenting.
 *
 * It deliberately does BOTH compilations in one request. A half-published
 * IntentLink - a workflow with no policy - would be a workflow with no
 * boundaries, and the engine denies by default, so it could never run anyway.
 * Better that publishing fails than that it half-succeeds.
 */

import {
  IntentLink,
  Policy,
  Trace,
  type Parameter,
} from "@intentlink/schema";
import {
  compileIntent,
  compilePolicy,
  geminiClient,
  type Binding,
  type Diagnostic,
  type ModelClient,
} from "@intentlink/compiler";
import { policyHash } from "@intentlink/policy";
import { randomUUID } from "node:crypto";

export interface PublishedLink {
  id: string;
  /**
   * Where the workflow begins, taken from the recording.
   *
   * Without it the receiver's extension runs against whatever tab happens to
   * be focused - which is the CONSENT PAGE, since that is what they just
   * clicked Run on. The agent then finds nothing resembling the workflow,
   * and the run is against the wrong document entirely.
   */
  startUrl?: string;
  intent: IntentLink;
  policy: Policy;
  bindings: Binding[];
  diagnostics: Diagnostic[];
  runnable: boolean;
  createdAt: string;
}

export interface PublishRequest {
  trace: unknown;
  boundaries: string;
  createdBy?: string;
  title?: string;
}

/**
 * Short, unguessable, and not a UUID.
 *
 * The id appears in a URL people paste into chat, so it wants to be short -
 * but it is also the only thing standing between a stranger and the consent
 * screen, so it wants real entropy. 16 chars of base32 is ~80 bits.
 */
function linkId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** app -> origin, taken from the recording rather than guessed. */
function originsFromTrace(trace: Trace): Record<string, string> {
  const origins: Record<string, string> = {};
  for (const event of trace.events) {
    origins[event.page.app] ??= event.page.origin;
  }
  return origins;
}

export async function publish(
  req: PublishRequest,
  model: ModelClient = geminiClient(),
): Promise<PublishedLink> {
  const trace = Trace.parse(req.trace);
  if (trace.events.length === 0) {
    throw new Error("the recording is empty — nothing to compile");
  }

  const intentId = randomUUID();
  const policyId = randomUUID();
  const createdBy = req.createdBy ?? "unknown";

  const { intent } = await compileIntent(model, trace, {
    intentId,
    policyId,
    createdBy,
    maxRepairs: 2,
  });

  const compiled = await compilePolicy(model, intent, req.boundaries, {
    policyId,
    origins: originsFromTrace(trace),
  });

  // Hash computed here, never accepted from a client: it is the integrity
  // claim that pins an execution to the boundaries the receiver consented to.
  const policy = Policy.parse({ ...compiled.policy, hash: policyHash(compiled.policy) });

  const published = IntentLink.parse({
    ...intent,
    title: req.title?.trim() || intent.title,
    status: "published",
  });

  const first = trace.events.find((e) => e.page.origin);

  return {
    id: linkId(),
    ...(first ? { startUrl: `${first.page.origin}${first.page.path}` } : {}),
    intent: published,
    policy,
    bindings: compiled.bindings,
    diagnostics: compiled.diagnostics,
    runnable: compiled.runnable,
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------ consent page ------------------------------ */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function paramRow(p: Parameter): string {
  const hint = p.recordedExample ? `e.g. ${esc(String(p.recordedExample))}` : "";
  return `<li><code>${esc(p.name)}</code> <span class="t">${esc(p.type)}</span>
    ${p.required ? '<span class="req">required</span>' : ""}
    <span class="hint">${hint}</span></li>`;
}

/**
 * The receiver's first and most important screen.
 *
 * Server-rendered on purpose: it must work before the extension is installed,
 * in any browser, with no build step between a creator sharing a link and
 * someone reading it. It reads like an OS permission grant rather than a
 * marketing page, because that is what it is.
 */
export function consentPage(link: PublishedLink, baseUrl: string): string {
  const { intent, policy } = link;

  /*
   * There is deliberately no "Allowed" list.
   *
   * A creator's boundaries are mostly prohibitions, so the compiler
   * synthesises permissions to cover the workflow - and those have no sentence
   * to quote, so they rendered as raw verb signatures
   * (set_channel_visibility visibility="private"). That restated "What it will
   * do" in worse language. The steps ARE the permitted actions, described the
   * way a person would describe them, so that section carries it.
   *
   * What a receiver actually needs to weigh is narrower: what it will do, what
   * will pause for them, and what it is forbidden from doing.
   */
  const approval = policy.approvalRequired
    .map((r) => `<li class="approve">${esc(r.sourceText ?? r.verb)} <span class="t">→ ${esc(r.route)}</span></li>`)
    .join("");
  const denied = policy.denied
    .map((r) => `<li class="deny">${esc(r.sourceText ?? r.verb)}</li>`)
    .join("");

  const steps = intent.steps
    .map(
      (s) =>
        `<li>${esc(s.title)}<span class="t"> ${esc(s.app)} · ${esc(s.action.verb)}</span>${
          s.condition ? `<span class="cond">only when ${esc(s.condition)}</span>` : ""
        }</li>`,
    )
    .join("");

  /*
   * Two different kinds of bad news, and only one of them is fatal.
   *
   * A blocked step means the workflow literally cannot complete - there is
   * nothing to consent to. A boundary that could not be compiled means the
   * run would have LESS protection than the creator described, which is a
   * risk for the receiver to weigh about their own account, not a reason to
   * refuse on their behalf. Conflating them disabled the button over a
   * sentence fragment ("from dark mode") that was never a restriction.
   */
  const blocking = link.diagnostics.filter(
    (d) => d.severity === "error" && d.code !== "unmatched_clause",
  );
  const unenforced = link.diagnostics.filter((d) => d.code === "unmatched_clause");
  const warnings = link.diagnostics.filter(
    (d) => d.severity === "warning" && d.code !== "unmatched_clause",
  );

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(intent.title)} — IntentLink</title>
<style>
  :root{--bg:#0d0f12;--panel:#14171c;--line:#242932;--text:#e6e9ef;--dim:#8b93a3;
        --allow:#2dd4a7;--approve:#f5b544;--deny:#ff5c6c;
        --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
        --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--sans);
       display:flex;justify-content:center;padding:32px 16px}
  main{width:100%;max-width:640px}
  .mark{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
  h1{font-size:24px;margin:.3em 0 .2em}
  .goal{color:var(--dim);margin:0 0 24px}
  section{border:1px solid var(--line);border-radius:10px;background:var(--panel);
          padding:16px 18px;margin-bottom:14px}
  h2{font-size:11px;font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase;
     color:var(--dim);margin:0 0 10px}
  ul{list-style:none;margin:0;padding:0}
  li{padding:5px 0 5px 20px;position:relative}
  li::before{position:absolute;left:0;font-family:var(--mono)}
  .allow::before{content:"+";color:var(--allow)}
  .approve::before{content:"?";color:var(--approve)}
  .deny::before{content:"\\2212";color:var(--deny)}
  .t{font-family:var(--mono);font-size:12px;color:var(--dim)}
  .cond{display:block;font-family:var(--mono);font-size:12px;color:var(--approve)}
  .hint{color:var(--dim);font-size:13px}
  .req{color:var(--approve);font-size:12px;font-family:var(--mono)}
  code{font-family:var(--mono);font-size:13px}
  .err{border-color:var(--deny)}
  .err h2{color:var(--deny)}
  .warn{border-color:var(--approve)}
  .warn h2{color:var(--approve)}
  .small{color:var(--dim);font-size:13px;margin:8px 0 0}
  .meta{display:flex;gap:16px;flex-wrap:wrap;font-family:var(--mono);font-size:12px;
        color:var(--dim);margin-bottom:20px}
  button{font:600 15px var(--sans);background:var(--allow);color:#06251c;border:0;
         border-radius:8px;padding:12px 20px;cursor:pointer;width:100%}
  button[disabled]{background:var(--line);color:var(--dim);cursor:not-allowed}
  .note{color:var(--dim);font-size:13px;margin-top:10px;text-align:center}
</style></head>
<body><main>
  <div class="mark">IntentLink</div>
  <h1>${esc(intent.title)}</h1>
  <p class="goal">${esc(intent.goal)}</p>

  <div class="meta">
    <span>${intent.steps.length} steps</span>
    <span>expires ${esc(new Date(policy.expiresAt).toUTCString())}</span>
    <span>${policy.limits.maxExecutions} run${policy.limits.maxExecutions === 1 ? "" : "s"}</span>
    <span>policy ${esc((policy.hash ?? "").slice(0, 12))}</span>
  </div>

  ${
    blocking.length
      ? `<section class="err"><h2>This link cannot run as written</h2><ul>${blocking
          .map((d) => `<li>${esc(d.message)}</li>`)
          .join("")}</ul></section>`
      : ""
  }
  ${
    unenforced.length
      ? `<section class="warn"><h2>Not enforced</h2><ul>${unenforced
          .map((d) => `<li>${esc(d.message)}</li>`)
          .join("")}</ul><p class="small">Everything else below still applies. You decide whether to run it.</p></section>`
      : ""
  }

  <section><h2>What it will do</h2><ul>${steps}</ul></section>
  ${approval ? `<section><h2>Needs approval</h2><ul>${approval}</ul></section>` : ""}
  ${denied ? `<section><h2>Prohibited</h2><ul>${denied}</ul></section>` : ""}
  ${
    intent.params.length
      ? `<section><h2>You will be asked for</h2><ul>${intent.params.map(paramRow).join("")}</ul></section>`
      : ""
  }
  ${
    warnings.length
      ? `<section><h2>Worth knowing</h2><ul>${warnings
          .map((d) => `<li>${esc(d.message)}</li>`)
          .join("")}</ul></section>`
      : ""
  }

  <button id="run"${link.runnable && !blocking.length ? "" : " disabled"}>Run in my browser</button>
  <p class="note">Runs with your own sessions. The creator never sees your credentials.</p>

  <script>
    // The extension injects this flag when it is installed; without it the
    // button explains what is missing rather than failing silently.
    document.getElementById("run").addEventListener("click", () => {
      const el = document.documentElement;
      if (!el.dataset.intentlinkExtension) {
        alert("Install the IntentLink extension, then reload this page.");
        return;
      }
      window.postMessage({ type: "intentlink:run", linkId: ${JSON.stringify(link.id)}, api: ${JSON.stringify(baseUrl)} }, "*");
    });
  </script>
</main></body></html>`;
}
