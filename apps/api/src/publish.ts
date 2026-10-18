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
import { describeIssues, fitTrace } from "./fit.js";

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

/**
 * Where the receiver's browser should go first.
 *
 * Not simply the trace's first event. A browser does its own navigating
 * before the person does theirs - a real recording opened with Chrome's
 * prefetch of google.com/search/warmup.html, and sending the receiver there
 * meant the run began on a blank Google page with nothing to resolve
 * against.
 *
 * The first STEP says which app the work is in, so the start is the first
 * recorded page belonging to that app.
 */
function startUrlFor(trace: Trace, intent: IntentLink): string | undefined {
  /*
   * The first STEP's own page, which the compiler took from the event it was
   * built on. Not the first event in the trace, and not the first page whose
   * app matches - a recording that began with a Google search and ended in
   * Gmail has both under the app name "google", so matching on that opened a
   * search page with no Compose button on it.
   */
  const recorded = intent.steps[0]?.page;
  if (recorded && /^https?:/.test(recorded.origin)) {
    return `${recorded.origin}${recorded.path}`;
  }

  // Older links, and anything the compiler could not place: fall back to the
  // first real page in the recording, skipping what the browser did on its own.
  const usable = trace.events.filter(
    (e) => /^https?:/.test(e.page.origin) && !/\b(warmup|newtab|blank)\b/.test(e.page.path),
  );
  const chosen = usable[0];
  return chosen ? `${chosen.page.origin}${chosen.page.path}` : undefined;
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
  const parsed = Trace.safeParse(fitTrace(req.trace));
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  const trace = parsed.data;
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

  return {
    id: linkId(),
    ...(startUrlFor(trace, published) ? { startUrl: startUrlFor(trace, published) } : {}),
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
  const example = p.recordedExample ? String(p.recordedExample) : "";
  // Long values are usually an element's own label rather than something a
  // person would type, so show enough to recognise it and no more.
  const shown = example.length > 64 ? `${example.slice(0, 64)}…` : example;
  return `<li class="param"><div class="param-head"><code>${esc(p.name)}</code><span class="t">${esc(p.type)}</span>
    ${p.required ? '<span class="req">required</span>' : ""}</div>
    ${shown ? `<div class="hint"><span class="hint-k">starts as</span> <span class="hint-v">${esc(shown)}</span></div>` : ""}</li>`;
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
    .map((r) => `<li class="rule approve"><span class="rule-text">${esc(r.sourceText ?? r.verb)}</span> <span class="t">→ ${esc(r.route)}</span></li>`)
    .join("");
  const denied = policy.denied
    .map((r) => `<li class="rule deny"><span class="rule-text">${esc(r.sourceText ?? r.verb)}</span></li>`)
    .join("");

  const steps = intent.steps
    .map(
      (s, i) =>
        `<li class="step"><span class="node">${String(i + 1).padStart(2, "0")}</span><div class="step-body"><div class="step-title">${esc(s.title)}</div><span class="t">${esc(s.app)} · ${esc(s.action.verb)}</span>${
          s.condition ? `<span class="cond">only when ${esc(s.condition)}</span>` : ""
        }</div></li>`,
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,300;1,400&display=swap">
<style>
  /* Single dark look, the product's own: three signal colours on near-black,
     Plex Mono for what the machine enforces, Plex Sans for what people said. */
  :root{color-scheme:dark;
        --bg:#0b0d10;--surface:#12151a;--raised:#171b21;
        --line:rgba(226,230,238,.08);--line2:rgba(226,230,238,.15);
        --text:#e8eaee;--soft:#c3c8d1;--dim:#8a919e;--faint:#59606c;
        --allow:#2dd4a7;--approve:#f5b544;--deny:#ff5c6c;
        --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
        --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
        --ease:cubic-bezier(.16,1,.3,1)}
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;color:var(--text);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;
       background:radial-gradient(90% 50% at 50% -8%,rgba(232,234,238,.07),transparent 60%),var(--bg)}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
       background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
       background-size:48px 48px;
       -webkit-mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000 20%,transparent 75%);
               mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000 20%,transparent 75%)}
  ::selection{background:rgba(232,234,238,.2)}

  .top{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:22px 24px;display:flex;align-items:center;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:12px;font:600 16px/1 var(--sans);letter-spacing:-.01em}
  .top-tag{font:500 11px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--dim);
           border:1px solid var(--line2);border-radius:999px;padding:7px 11px;display:flex;align-items:center;gap:8px}
  .top-tag i{width:6px;height:6px;border-radius:50%;border:1.5px solid var(--soft)}

  .page{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:24px 24px 64px;
        display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;align-items:start}
  @media (max-width:960px){.page{grid-template-columns:minmax(0,1fr);gap:20px}}

  .hero{grid-column:1/-1;padding:18px 0 10px;animation:rise .6s var(--ease) both}
  .eyebrow{font:500 11px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
  h1{margin:14px 0 10px;font:600 clamp(30px,4.6vw,48px)/1.08 var(--sans);letter-spacing:-.03em;text-wrap:balance;max-width:820px}
  .goal{color:var(--soft);margin:0;font-size:17px;max-width:680px;text-wrap:pretty}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}
  .meta span{font:400 12px/1 var(--mono);color:var(--soft);padding:8px 11px;border-radius:8px;
             background:rgba(255,255,255,.03);border:1px solid var(--line)}
  .meta b{color:var(--text);font-weight:500}

  .col{display:grid;gap:16px;min-width:0}
  section{background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0) 40%),var(--surface);
          border:1px solid var(--line);border-radius:16px;padding:20px 22px;
          box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 20px 40px -28px rgba(0,0,0,.9);
          animation:rise .6s var(--ease) both}
  .col section:nth-child(2){animation-delay:.05s}.col section:nth-child(3){animation-delay:.1s}
  .col section:nth-child(4){animation-delay:.15s}.col section:nth-child(5){animation-delay:.2s}
  h2{display:flex;align-items:center;gap:10px;font:500 11px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 16px}
  h2 .count{margin-left:auto;color:var(--faint);letter-spacing:.06em}
  ul{list-style:none;margin:0;padding:0}
  .t{font:400 12px/1.4 var(--mono);color:var(--dim)}
  code{font:500 13px var(--mono);color:var(--text)}
  .small{color:var(--dim);font-size:13px;margin:14px 0 0}

  /* What it will do: a chain, one node per step. */
  .steps{position:relative}
  .step{position:relative;display:grid;grid-template-columns:30px 1fr;gap:14px;padding:0 0 14px}
  .step:last-child{padding-bottom:0}
  .step::before{content:"";position:absolute;left:14.5px;top:30px;bottom:0;width:1px;background:var(--line2)}
  .step:last-child::before{display:none}
  .node{position:relative;z-index:1;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;
        font:500 11px/1 var(--mono);color:var(--text);background:var(--bg);border:1px solid var(--line2);
        box-shadow:0 0 0 4px rgba(232,234,238,.03)}
  .step-body{padding-top:4px;min-width:0}
  .step-title{font-size:15px;color:var(--text)}
  .cond{display:block;margin-top:4px;font:400 12px var(--mono);color:var(--approve)}

  /* Rules, in the creator's own words. */
  .rule{position:relative;padding:12px 14px 12px 18px;border-radius:10px;margin-top:8px;background:rgba(255,255,255,.02);border:1px solid var(--line)}
  .rule:first-child{margin-top:0}
  .rule::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0}
  .rule-text{font:italic 400 16px/1.4 var(--sans);color:var(--text)}
  .rule.deny::before{background:var(--deny);box-shadow:0 0 12px rgba(255,92,108,.7)}
  .rule.approve::before{background:var(--approve);box-shadow:0 0 12px rgba(245,181,68,.6)}
  .never h2{color:var(--deny)}
  .never{border-color:rgba(255,92,108,.22)}
  .pause h2{color:var(--approve)}

  .param{padding:12px 0;border-top:1px solid var(--line)}
  .param:first-child{border-top:0;padding-top:0}
  .param-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .req{font:500 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--approve);
       border:1px solid rgba(245,181,68,.4);border-radius:999px;padding:4px 7px}
  .hint{margin-top:6px;font-size:13px;color:var(--dim);word-break:break-word}
  .hint-v{color:var(--allow);font-family:var(--mono);font-size:12.5px}

  .err{border-color:rgba(255,92,108,.5);background:linear-gradient(180deg,rgba(255,92,108,.08),transparent 70%),var(--surface)}
  .err h2{color:var(--deny)}
  .warn{border-color:rgba(245,181,68,.45);background:linear-gradient(180deg,rgba(245,181,68,.07),transparent 70%),var(--surface)}
  .warn h2{color:var(--approve)}
  .err li,.warn li,.notes li{position:relative;padding:4px 0 4px 18px;color:var(--soft)}
  .err li::before,.warn li::before,.notes li::before{content:"";position:absolute;left:2px;top:13px;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.6}
  .err li::before{background:var(--deny);opacity:1}.warn li::before{background:var(--approve);opacity:1}

  /* The decision. Sticky beside the details on wide screens. */
  .decide{position:sticky;top:24px;padding:22px;border-color:rgba(232,234,238,.18);
          box-shadow:0 0 0 1px rgba(232,234,238,.04),0 30px 60px -30px rgba(0,0,0,.9),0 0 60px -30px rgba(232,234,238,.3);
          animation-delay:.1s}
  .decide-k{font:500 11px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
  .decide-t{margin:10px 0 18px;font:500 20px/1.3 var(--sans);letter-spacing:-.015em;text-wrap:balance}
  .trust{display:grid;gap:12px;margin:0 0 20px}
  .trust li{display:grid;grid-template-columns:22px 1fr;gap:10px;align-items:start;font-size:13.5px;color:var(--soft);line-height:1.45}
  .trust svg{margin-top:1px}
  button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;
         font:600 16px/1 var(--sans);background:var(--text);color:#0b0d10;border:0;border-radius:12px;padding:16px 20px;cursor:pointer;
         box-shadow:0 0 0 1px rgba(255,255,255,.12) inset,0 14px 40px -14px rgba(232,234,238,.6);
         transition:background .15s,transform .1s,box-shadow .2s}
  button:hover{background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.2) inset,0 18px 50px -14px rgba(232,234,238,.75)}
  button:active{transform:translateY(1px) scale(.995)}
  button:focus-visible{outline:2px solid rgba(232,234,238,.6);outline-offset:3px}
  button .arrow{transition:transform .2s var(--ease)}
  button:hover .arrow{transform:translateX(4px)}
  button[disabled]{background:var(--raised);color:var(--faint);cursor:not-allowed;box-shadow:none;border:1px solid var(--line2)}
  button[disabled] .arrow{display:none}
  .note{color:var(--dim);font-size:12.5px;margin:14px 0 0;text-align:center;line-height:1.5}
  .fine{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);font:400 11px/1.7 var(--mono);color:var(--faint);word-break:break-all}

  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head>
<body>
<header class="top">
  <span class="brand">
    <svg width="46" height="14" viewBox="0 0 46 14" aria-hidden="true"><line x1="4" y1="7" x2="30" y2="7" stroke="#e8eaee" stroke-opacity=".45" stroke-width="1.3"/><circle cx="4" cy="7" r="3" fill="#e8eaee"/><circle cx="17" cy="7" r="3" fill="#e8eaee"/><circle cx="30" cy="7" r="3" fill="#e8eaee"/><rect x="39" y="0.5" width="2.4" height="13" rx="1.2" fill="#ff5c6c"/></svg>
    IntentLink
  </span>
  <span class="top-tag"><i></i>Shared with you</span>
</header>
<main class="page">
  <div class="hero">
    <div class="eyebrow">A task, with boundaries</div>
    <h1>${esc(intent.title)}</h1>
    <p class="goal">${esc(intent.goal)}</p>
    <div class="meta">
      <span><b>${intent.steps.length}</b> steps</span>
      <span>expires ${esc(new Date(policy.expiresAt).toUTCString())}</span>
      <span><b>${policy.limits.maxExecutions}</b> run${policy.limits.maxExecutions === 1 ? "" : "s"}</span>
      <span>policy ${esc((policy.hash ?? "").slice(0, 12))}</span>
    </div>
  </div>

  <div class="col">
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

  <section><h2>What it will do <span class="count">${intent.steps.length} steps</span></h2><ul class="steps">${steps}</ul></section>
  ${approval ? `<section class="pause"><h2>Needs approval</h2><ul>${approval}</ul></section>` : ""}
  ${denied ? `<section class="never"><h2>Prohibited</h2><ul>${denied}</ul></section>` : ""}
  ${
    intent.params.length
      ? `<section><h2>You can change</h2><ul>${intent.params.map(paramRow).join("")}</ul>
         <p class="small">Each starts at the value from the recording. Run it as-is, or change one to do the same workflow for something else.</p></section>`
      : ""
  }
  ${
    warnings.length
      ? `<section class="notes"><h2>Worth knowing</h2><ul>${warnings
          .map((d) => `<li>${esc(d.message)}</li>`)
          .join("")}</ul></section>`
      : ""
  }
  </div>

  <aside>
    <section class="decide">
      <div class="decide-k">Your decision</div>
      <div class="decide-t">Run this in your own browser, inside these rules.</div>
      <ul class="trust">
        <li><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" rx="2" fill="none" stroke="#c3c8d1" stroke-width="1.3"/><line x1="2.5" y1="6.5" x2="15.5" y2="6.5" stroke="#c3c8d1" stroke-width="1.3"/></svg><span>Runs in this browser, signed in as you.</span></li>
        <li><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5l5.5 2v4.2c0 3.3-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.5-5.5-6.8V4.5z" fill="none" stroke="#c3c8d1" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.6 9l1.7 1.7 3.2-3.4" fill="none" stroke="#2dd4a7" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Every action is checked against these rules before it happens.</span></li>
        <li><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.3" fill="none" stroke="#c3c8d1" stroke-width="1.3"/><line x1="12" y1="3.4" x2="12" y2="14.6" stroke="#ff5c6c" stroke-width="1.6" stroke-linecap="round"/></svg><span>Anything outside them is blocked, not attempted.</span></li>
      </ul>
      <button id="run"${link.runnable && !blocking.length ? "" : " disabled"}>Run in my browser <span class="arrow" aria-hidden="true">→</span></button>
      <p class="note">Runs with your own sessions. The creator never sees your credentials.</p>
      <div class="fine">policy ${esc(policy.hash ?? "")}</div>
    </section>
  </aside>

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
