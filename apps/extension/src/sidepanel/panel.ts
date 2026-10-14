/**
 * Side panel — the human's view and the human's controls.
 *
 * Renders from worker state rather than keeping its own. The panel can be
 * closed and reopened, and the worker can die and restart, at any point during
 * a recording or a run; anything the panel remembered locally would be a
 * second source of truth that is wrong half the time.
 */

import type { TraceEvent } from "@intentlink/schema";
import type { ExecutionState, PanelMessage, PanelState, TimelineEntry } from "../shared/protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  record: $("record") as HTMLButtonElement,
  pause: $("pause") as HTMLButtonElement,
  stop: $("stop") as HTMLButtonElement,
  status: $("status"),
  meta: $("meta"),
  eventCount: $("event-count"),
  apps: $("apps"),
  coords: $("coords"),
  steps: $("steps") as HTMLOListElement,
  empty: $("empty"),
  tally: $("tally"),
  tAllow: $("t-allow"),
  tBlocked: $("t-blocked"),
  tApprovals: $("t-approvals"),
  block: $("block"),
  blockReason: $("block-reason"),
  blockBoundary: $("block-boundary"),
  blockSuggestion: $("block-suggestion"),
  publish: $("publish"),
  boundaries: $("boundaries") as HTMLTextAreaElement,
  create: $("create") as HTMLButtonElement,
  result: $("result"),
  link: $("link") as HTMLAnchorElement,
  copy: $("copy") as HTMLButtonElement,
  working: $("working"),
  run: $("run"),
  runTitle: $("run-title"),
  runGoal: $("run-goal"),
  params: $("params") as HTMLFormElement,
  runActions: $("run-actions"),
  start: $("start") as HTMLButtonElement,
  abort: $("abort") as HTMLButtonElement,
  timeline: $("timeline") as HTMLOListElement,
};

async function ask(message: PanelMessage): Promise<PanelState | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as PanelState;
  } catch {
    return undefined;
  }
}

/** Human-readable summary of what one recorded step did. */
function describeStep(event: TraceEvent): string {
  const name = event.target?.name?.trim();
  const role = event.target?.role ?? "element";
  const label = name ? `“${name}”` : `an unnamed ${role}`;

  switch (event.type) {
    case "navigate":
      return `went to ${event.page.routeTemplate ?? event.page.path}`;
    case "click":
      return `clicked ${label}`;
    case "toggle":
      return `toggled ${label}`;
    case "select":
      return `chose an option in ${label}`;
    case "fill":
      return `filled ${label}`;
    case "submit":
      return `submitted from ${label}`;
    default:
      return `${event.type} ${label}`;
  }
}

function renderStep(event: TraceEvent): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "step";

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = String(event.seq).padStart(2, "0");

  const body = document.createElement("div");

  const what = document.createElement("div");
  what.className = "what";
  what.textContent = describeStep(event);
  body.appendChild(what);

  if (event.target) {
    const d = document.createElement("div");
    d.className = "descriptor";
    // The descriptor itself, shown verbatim. A viewer can read it and see for
    // themselves that there is no coordinate and no selector in there.
    const parts = [`${event.target.role}`, `name=${JSON.stringify(event.target.name)}`];
    if (event.target.section) parts.push(`section=${JSON.stringify(event.target.section)}`);
    d.textContent = parts.join("  ");
    body.appendChild(d);
  }

  if (event.redacted) {
    const r = document.createElement("div");
    r.className = "descriptor redacted";
    r.textContent = `value withheld (${event.redactionReason ?? "sensitive"})`;
    body.appendChild(r);
  } else if (event.value !== undefined) {
    const v = document.createElement("div");
    v.className = "descriptor";
    const span = document.createElement("span");
    span.className = "value";
    span.textContent = JSON.stringify(event.value);
    v.append("value = ", span);
    body.appendChild(v);
  }

  li.append(seq, body);
  return li;
}

/**
 * The parameter form.
 *
 * Rebuilt only when the set of parameters changes, so typing into a field is
 * not wiped by the next poll - the panel re-renders every second.
 */
let renderedParamsFor = "";

function renderParams(execution: ExecutionState): void {
  const pending = execution.pendingParams ?? [];
  const signature = pending.map((p) => p.name).join(",");
  if (signature === renderedParamsFor) return;
  renderedParamsFor = signature;

  els.params.textContent = "";
  els.params.hidden = pending.length === 0;

  for (const param of pending) {
    const label = document.createElement("label");
    label.textContent = param.description || param.name;

    let field: HTMLInputElement | HTMLSelectElement;
    if (param.enumValues?.length) {
      const select = document.createElement("select");
      for (const value of param.enumValues) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        if (value === param.recordedExample) option.selected = true;
        select.appendChild(option);
      }
      field = select;
    } else {
      const input = document.createElement("input");
      input.type = param.type === "number" ? "number" : "text";
      if (param.required) input.required = true;
      /*
       * Pre-filled with what the creator demonstrated.
       *
       * Running a workflow as recorded should take one click, not retyping.
       * It also rescues a parameter whose value nobody could reproduce - a
       * search result's full accessible name, duration and all - which is
       * otherwise a form field that cannot be filled in correctly by anyone
       * except the person who made the recording.
       */
      if (param.recordedExample) input.value = param.recordedExample;
      field = input;
    }
    field.name = param.name;
    field.id = `param-${param.name}`;
    label.htmlFor = field.id;
    label.appendChild(field);

    const eg = document.createElement("span");
    eg.className = "eg";
    eg.textContent = param.recordedExample
      ? "pre-filled from the recording — change it to run this for something else"
      : param.required
        ? "required"
        : "optional";
    label.appendChild(eg);
    els.params.appendChild(label);
  }
}

function renderTimeline(entries: TimelineEntry[]): void {
  els.timeline.hidden = entries.length === 0;
  els.timeline.textContent = "";

  const mark: Record<string, string> = {
    ALLOW: "+", APPROVAL: "?", DENY: "\u2212", verified: "\u2713", failed: "!", info: "\u00b7",
  };

  for (const entry of entries.slice(-60)) {
    const li = document.createElement("li");
    li.className = entry.verdict;

    const v = document.createElement("span");
    v.className = "v";
    v.textContent = mark[entry.verdict] ?? "\u00b7";

    const what = document.createElement("div");
    what.className = "what";
    if (entry.verb) {
      const verb = document.createElement("span");
      verb.className = "verb";
      verb.textContent = entry.verb + " ";
      what.appendChild(verb);
    }
    what.appendChild(document.createTextNode(entry.target ?? entry.detail ?? ""));
    if (entry.target && entry.detail) {
      what.appendChild(document.createTextNode(` — ${entry.detail}`));
    }
    if (entry.boundary) {
      const b = document.createElement("span");
      b.className = "boundary";
      b.textContent = `“${entry.boundary}”`;
      what.appendChild(b);
    }

    li.append(v, what);
    els.timeline.appendChild(li);
  }
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

function render(state: PanelState | undefined): void {
  if (!state) return;
  const { recording, execution } = state;
  const isRecording = recording.status === "recording";
  const isPaused = recording.status === "paused";
  const active = isRecording || isPaused;

  els.record.hidden = active;
  els.pause.hidden = !active;
  els.stop.hidden = !active;
  els.pause.textContent = isPaused ? "Resume" : "Pause";
  els.record.classList.toggle("recording", isRecording);
  els.status.textContent = recording.status;

  const events = recording.events ?? [];
  els.meta.hidden = events.length === 0;
  els.eventCount.textContent = `${events.length} step${events.length === 1 ? "" : "s"}`;
  els.apps.textContent = recording.apps.join(" → ") || "—";
  // Always zero, by construction. Stated as a live number rather than a claim.
  els.coords.textContent = "0";

  // Offered once there is something worth publishing and recording has stopped
  // - compiling a trace that is still growing would compile a half-done task.
  els.publish.hidden = events.length === 0 || active;

  els.empty.hidden = events.length > 0;
  els.steps.textContent = "";
  for (const event of events) els.steps.appendChild(renderStep(event));

  const ran = execution.allowed + execution.blocked + execution.approvals > 0;
  els.tally.hidden = !ran;
  els.tAllow.textContent = String(execution.allowed);
  els.tBlocked.textContent = String(execution.blocked);
  els.tApprovals.textContent = String(execution.approvals);

  // A run takes over the panel; recording controls would only be in the way.
  const running = execution.status !== "idle";
  els.run.hidden = !running;
  if (running) {
    els.runTitle.textContent = execution.title ?? "IntentLink";
    els.runGoal.textContent = execution.error ?? execution.goal ?? "";
    renderParams(execution);
    els.runActions.hidden = execution.status !== "awaiting_params";
  }
  renderTimeline(execution.timeline ?? []);

  const block = execution.lastBlock;
  els.block.hidden = !block;
  if (block) {
    els.blockReason.textContent = block.reason;
    els.blockBoundary.hidden = !block.boundary;
    if (block.boundary) els.blockBoundary.textContent = `“${block.boundary}”`;
    els.blockSuggestion.hidden = !block.suggestion;
    if (block.suggestion) els.blockSuggestion.textContent = block.suggestion;
  }
}

els.start.addEventListener("click", async () => {
  const params: Record<string, string> = {};
  for (const [name, value] of new FormData(els.params).entries()) {
    params[name] = String(value);
  }
  els.start.disabled = true;
  render(await ask({ type: "panel:submitParams", params } as PanelMessage));
  els.start.disabled = false;
});

els.abort.addEventListener("click", async () => {
  render(await ask({ type: "panel:cancelRun" }));
});

els.create.addEventListener("click", async () => {
  els.create.disabled = true;
  els.working.hidden = false;
  els.result.hidden = true;
  try {
    const published = await ask({
      type: "panel:publish",
      boundaries: els.boundaries.value.trim(),
    } as PanelMessage & { boundaries: string });

    const link = (published as unknown as { url?: string; error?: string }) ?? {};
    if (link.url) {
      els.link.textContent = link.url;
      els.link.href = link.url;
      els.result.hidden = false;
    } else {
      els.working.textContent = link.error ?? "Could not publish.";
      return;
    }
  } finally {
    els.create.disabled = false;
    els.working.hidden = true;
    els.working.textContent = "Compiling the recording, then your boundaries…";
  }
});

els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.link.textContent ?? "");
  els.copy.textContent = "Copied";
  setTimeout(() => (els.copy.textContent = "Copy"), 1200);
});

els.record.addEventListener("click", async () => {
  render(await ask({ type: "panel:startRecording" }));
});

els.pause.addEventListener("click", async () => {
  const state = await ask({ type: "panel:getState" });
  const paused = state?.recording.status === "paused";
  render(await ask({ type: paused ? "panel:resumeRecording" : "panel:pauseRecording" }));
});

els.stop.addEventListener("click", async () => {
  render(await ask({ type: "panel:stopRecording" }));
});

/*
 * Poll rather than subscribe. Capture events arrive from content scripts in
 * other tabs, and the worker may restart between any two of them; a one-second
 * poll is simpler than a subscription that has to be re-established every time
 * the worker comes back, and the panel is never the bottleneck.
 */
async function tick(): Promise<void> {
  render(await ask({ type: "panel:getState" }));
}

void tick();
setInterval(() => void tick(), 1000);
