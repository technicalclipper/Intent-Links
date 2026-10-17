/**
 * The executor: the loop that actually runs an IntentLink.
 *
 * It lives in the service worker, which MV3 kills without warning, so every
 * durable thing is read from and written to chrome.storage rather than held in
 * a variable. A run that cannot survive the worker being reclaimed mid-step is
 * a run that fails on a slow page.
 *
 * The shape of one iteration:
 *
 *   observe   ask every frame to resolve the step's recorded hints
 *   propose   hand the observation to the agent; it chooses ONE action
 *   authorize the agent's gate already asked the policy service; we redeem the
 *             single-use token it returned, which is what actually permits us
 *   act       perform it in the frame that owns the element
 *   verify    read the page back and check the step's postcondition
 *
 * The extension never decides whether something is allowed. It carries a token
 * or it does not act.
 */

import type {
  ActResult,
  Candidate,
  ExecutionState,
  TimelineEntry,
  WorkerMessage,
} from "../shared/protocol.js";

const KEY = "intentlink:execution";

/**
 * Read a JSON response, or explain what actually came back.
 *
 * A failing service does not always answer in JSON - uvicorn returns a plain
 * "Internal Server Error", a proxy returns HTML - and calling .json() on that
 * throws a parse error that names the first character of the body. The
 * receiver then sees `Unexpected token 'I'` instead of "the agent crashed",
 * which hides the real failure behind a decoy.
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    const detail = body.trim().slice(0, 200) || res.statusText;
    throw new Error(`${what} failed (${res.status}): ${detail}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${what} returned something that is not JSON: ${body.slice(0, 200)}`);
  }
}

export const IDLE: ExecutionState = {
  status: "idle",
  allowed: 0,
  blocked: 0,
  approvals: 0,
  timeline: [],
};

/** Beyond this the agent is looping rather than progressing. */
const MAX_TURNS = 60;

type FramedCandidate = Candidate & { frameId: number };

export async function getExecution(): Promise<ExecutionState> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as ExecutionState | undefined) ?? IDLE;
}

export async function setExecution(state: ExecutionState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

async function patch(update: Partial<ExecutionState>): Promise<ExecutionState> {
  const next = { ...(await getExecution()), ...update };
  await setExecution(next);
  return next;
}

async function note(entry: Omit<TimelineEntry, "at">): Promise<void> {
  const state = await getExecution();
  // Bounded: a long run should not grow storage without limit, and the panel
  // only ever shows the tail.
  const timeline = [...state.timeline, { ...entry, at: Date.now() }].slice(-200);
  await setExecution({ ...state, timeline });
}

/* ------------------------------- starting -------------------------------- */

interface CompiledStep {
  id: string;
  title: string;
  app: string;
  hints: unknown[];
  /** The recording committed the field, so this step must too. */
  submits?: boolean;
  /** Steps that must have succeeded before this one is attempted. */
  dependsOn: string[];
  condition?: string;
  /** Where the step was demonstrated; absent on links made before it was recorded. */
  page?: { app: string; origin: string; path: string };
  action: {
    verb: string;
    object?: string;
    args: Record<string, { literal?: string | number | boolean; param?: string }>;
  };
}

interface LinkResponse {
  id: string;
  startUrl?: string;
  intent: {
    title: string;
    goal: string;
    params: ExecutionState["pendingParams"];
    steps: CompiledStep[];
  };
  policyId: string;
  agentUrl?: string;
  runnable: boolean;
}

/**
 * Fetch the IntentLink and stop for parameters.
 *
 * Nothing executes here. The receiver has read the consent page, but the
 * parameters are the last thing that is still theirs to decide, and a run that
 * began before they supplied them would be acting on the creator's recorded
 * values - someone else's incident, someone else's customer.
 */
export async function beginRun(linkId: string, api: string): Promise<ExecutionState> {
  await patch({ ...IDLE, status: "loading", linkId, api });

  let link: LinkResponse;
  try {
    link = await readJson<LinkResponse>(
      await fetch(`${api}/v1/links/${encodeURIComponent(linkId)}`),
      "loading the IntentLink",
    );
  } catch (err) {
    return patch({
      status: "failed",
      error: err instanceof Error ? err.message : "could not load the IntentLink",
    });
  }

  if (!link.runnable) {
    return patch({
      status: "failed",
      error: "This IntentLink cannot run: its boundaries block its own steps.",
    });
  }

  const params = link.intent.params ?? [];
  const agent = link.agentUrl ?? api;

  await note({ verdict: "info", detail: `Loaded “${link.intent.title}”` });

  return patch({
    status: params.length ? "awaiting_params" : "running",
    title: link.intent.title,
    goal: link.intent.goal,
    agent,
    pendingParams: params,
  });
}

/* -------------------------------- fast path ------------------------------- */

/**
 * Resolve a step without asking the model.
 *
 * The agent exists to make a judgment - which control on this page satisfies
 * the step - and when the deterministic resolver returns one exact,
 * unambiguous match there is no judgment left to make. Asking anyway costs a
 * full model turn, two to four seconds, on every action of every run.
 *
 * This is not a shortcut around the policy engine. The action still goes to
 * /decide, still needs a token, still gets redeemed. Only the model is
 * skipped, and only when it would have nothing to contribute.
 */
/*
 * Thresholds for acting without the model.
 *
 * 0.995 was the first attempt and it never fired. A real run scored 1.00,
 * 0.94, 0.94, 0.84, 0.84 - every one a confident, unmistakable match, and
 * every one paying for a full model turn because it fell short of "exact".
 * An optimisation that never triggers is not conservative, it is dead code.
 *
 * What makes a match safe to act on is not perfection, it is CERTAINTY: a
 * strong score with nothing else near it. When the runner-up is far behind,
 * asking a model which of the two is meant has only one possible answer.
 */
const FAST_PATH_CONFIDENCE = 0.78;
const FAST_PATH_MARGIN = 0.12;

export function fastPathCandidate(
  candidates: FramedCandidate[],
): FramedCandidate | undefined {
  const [best, runnerUp] = candidates;
  if (!best || best.confidence < FAST_PATH_CONFIDENCE) return undefined;

  // A close second means the descriptors do not actually distinguish them,
  // and choosing between them is exactly the judgment worth paying for.
  if (runnerUp && best.confidence - runnerUp.confidence < FAST_PATH_MARGIN) {
    return undefined;
  }
  return best;
}

/**
 * The text a fill or select should enter.
 *
 * Compiled arguments are named for what they mean - query, summary, topic,
 * name - and the executor was looking for one literally called "value". So a
 * search step carrying {query: "selena gomez"} passed nothing along, and the
 * fill failed for want of a value it was holding the whole time.
 *
 * With one string argument there is no ambiguity. With several, prefer the
 * one that names the text being entered.
 */
const TEXT_ARG_NAMES = ["value", "query", "text", "content", "summary", "topic", "title", "name"];

export function valueFor(args: Record<string, string | number | boolean>): string | undefined {
  const strings = Object.entries(args).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (strings.length === 0) return undefined;
  if (strings.length === 1) return strings[0]![1];

  for (const preferred of TEXT_ARG_NAMES) {
    const hit = strings.find(([name]) => name.toLowerCase() === preferred);
    if (hit) return hit[1];
  }
  return strings[0]![1];
}

/** The step's own action, with the receiver's parameters filled in. */
function actionFor(
  step: CompiledStep,
  params: Record<string, string>,
): { verb: string; object?: string; args: Record<string, string | number | boolean> } {
  const args: Record<string, string | number | boolean> = {};
  for (const [name, arg] of Object.entries(step.action.args ?? {})) {
    if (arg.literal !== undefined) args[name] = arg.literal;
    else if (arg.param && params[arg.param] !== undefined) args[name] = params[arg.param]!;
  }
  return {
    verb: step.action.verb,
    ...(step.action.object !== undefined ? { object: step.action.object } : {}),
    args,
  };
}

/* --------------------------------- the loop ------------------------------- */

interface TurnResponse {
  status: "action" | "blocked" | "awaiting_approval" | "done" | "failed";
  narration?: string;
  instruction?: {
    handle: number;
    verb: string;
    object?: string;
    value?: string;
    submit?: boolean;
    targetHash: string;
    targetName?: string;
    stepId: string;
  };
  token?: string;
  assertion?: { describe: string; expect: Record<string, unknown>; stepId: string };
  block?: { reason: string; boundary?: string; suggestion?: string; route?: string };
}

export async function runLoop(params: Record<string, string>): Promise<void> {
  const state = await getExecution();
  if (!state.linkId || !state.api || !state.agent) {
    await patch({ status: "failed", error: "no IntentLink is loaded" });
    return;
  }


  let link: LinkResponse;
  let executionId: string;
  let tab: chrome.tabs.Tab | undefined;
  try {
    // Fetched again rather than trusted from before: the steps and their hints
    // are what we resolve against.
    link = await readJson<LinkResponse>(
      await fetch(`${state.api}/v1/links/${state.linkId}`),
      "loading the IntentLink",
    );

    tab = await targetTab(link.startUrl);
    if (!tab?.id) throw new Error("could not open the page this workflow runs on");

    const started = await readJson<{ execution_id: string }>(
      await fetch(`${state.agent}/v1/run/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: (link as unknown as { intent: unknown }).intent,
          policy_id: link.policyId,
          params,
          receiver: null,
        }),
      }),
      "starting the run",
    );
    executionId = started.execution_id;
  } catch (err) {
    await patch({
      status: "failed",
      error: err instanceof Error ? err.message : "could not start the run",
    });
    return;
  }

  await patch({ status: "running", executionId, pendingParams: [] });
  // Not const: a workflow that spans apps moves to each app's tab in turn.
  let tabId = tab.id!;

  let lastResult: Record<string, unknown> | null = null;
  let stepIndex = 0;

  /**
   * Steps that genuinely happened - an action was authorized, redeemed and
   * performed. Nothing else counts as done.
   *
   * This exists because an agent once reported a workflow "successfully
   * completed and verified" having never called perform_action at all. It
   * went straight to assert_outcome, the assertion ran against a page where
   * nothing had changed, and the receiver was told the work was finished.
   *
   * A false success is the worst failure this system can produce: a block is
   * visible and recoverable, but a confident lie is neither. So completion is
   * tracked here, in code, rather than taken from the agent's word for it.
   */
  const performed = new Set<string>();

  /** Steps not attempted because something they needed did not happen. */
  const skipped = new Set<string>();

  /**
   * Consecutive failures of the same step, to stop a loop that is going
   * nowhere.
   *
   * A real run produced the same failure ten times: the agent proposed the
   * same action, it failed for the same reason, and nothing in the loop
   * noticed it was not progressing. Repeating an action that just failed
   * identically is not persistence, it is a spin - and on a page where some
   * of those attempts might succeed, it is worse than a spin.
   */
  let repeated = 0;
  let lastFailure = "";
  /** Report each step's search once, not on every turn it takes. */
  let lastReported = -1;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const current = await getExecution();
    if (current.status === "aborted") return;

    const step = link.intent.steps[Math.min(stepIndex, link.intent.steps.length - 1)];

    /*
     * A step whose prerequisites failed must not run.
     *
     * dependsOn was recorded and then ignored. A Gmail run could not set the
     * recipient - the control was not there - and went on to press Send
     * anyway. Nothing was sent only because Gmail refused an email with no
     * recipient; the executor had no opinion about it either way, which is
     * not a property to rely on when the next workflow transfers something.
     */
    if (step && step.dependsOn.some((id) => !performed.has(id))) {
      const missing = step.dependsOn.filter((id) => !performed.has(id));
      const names = missing.map(
        (id) => link.intent.steps.find((st) => st.id === id)?.title ?? id,
      );
      await note({
        verdict: "failed",
        stepId: step.id,
        detail: `skipped: it needs ${names.join(" and ")}, which did not happen`,
      });
      skipped.add(step.id);
      lastResult = { stepId: step.id, status: "skipped" };
      stepIndex++;
      if (stepIndex >= link.intent.steps.length) {
        await patch({ status: "done" });
        return;
      }
      continue;
    }

    /*
     * Go where the step happens.
     *
     * A recording of "send an email, then switch YouTube to dark theme" ran
     * every step in the Gmail tab: the email went out, then the run looked for
     * YouTube's "Account menu" on Gmail, found nothing, and skipped the rest.
     * Each step records the page it was demonstrated on, so when that is a
     * different site from the one in front of us, switch to it - reusing a tab
     * already open there, or opening one - before looking for anything.
     *
     * Only a change of ORIGIN moves the run. Within one app, the steps
     * themselves navigate (clicking Compose changes Gmail's route), and
     * reloading the recorded path would undo that.
     */
    const stepUrl = step ? pageUrlFor(step) : undefined;
    if (stepUrl && new URL(stepUrl).origin !== (await tabOrigin(tabId))) {
      const moved = await targetTab(stepUrl);
      if (moved?.id !== undefined) {
        tabId = moved.id;
        await note({
          verdict: "info",
          stepId: step!.id,
          detail: `switched to ${step!.page?.app ?? new URL(stepUrl).host} for “${step!.title}”`,
        });
      }
    }

    /*
     * Resolution used to be invisible. A run that found nothing reported
     * "nothing was done" and left no trace of what it had been looking for or
     * what was on the page - which is the one thing needed to fix it.
     */
    const observation = await observeWithRetry(tabId, step);
    const wanted = (step?.hints?.[0] as { role?: string; name?: string } | undefined);
    const best = observation.candidates[0];

    if (step && stepIndex !== lastReported) {
      lastReported = stepIndex;
      await note({
        verdict: best ? "info" : "failed",
        stepId: step.id,
        detail: best
          ? `looking for ${wanted?.role ?? "?"} “${wanted?.name ?? ""}” — best match ${
              best.descriptor.role
            } “${best.descriptor.name}” at ${best.confidence.toFixed(2)}`
          : `looking for ${wanted?.role ?? "?"} “${wanted?.name ?? ""}” — nothing on this page matched`,
      });
    }

    /*
     * When resolution is certain, act without a model turn.
     *
     * A conditional step is excluded: deciding whether the condition holds on
     * this page IS a judgment, and the resolver has no opinion about it.
     */
    const certain = step && !step.condition ? fastPathCandidate(observation.candidates) : undefined;
    if (certain && step) {
      const { verb, object, args } = actionFor(step, params);
      const decided = await decide(state.api, {
        policyId: link.policyId,
        executionId,
        stepId: step.id,
        verb,
        ...(object !== undefined ? { object } : {}),
        args,
        // The step's own site, not the workflow's first one: scope is checked
        // per origin, and a YouTube step is not a Gmail action.
        origin: new URL(stepUrl ?? link.startUrl ?? "https://localhost").origin,
        targetHash: certain.targetHash,
        targetName: certain.descriptor.name,
      });

      if (decided?.outcome === "ALLOW" && decided.token) {
        const result = await authorizeAndAct(
          tabId,
          state.api,
          executionId,
          {
            handle: certain.handle,
            verb,
            ...(object !== undefined ? { object } : {}),
            ...(valueFor(args) !== undefined ? { value: valueFor(args)! } : {}),
            ...(step.submits ? { submit: true } : {}),
            targetHash: certain.targetHash,
            targetName: certain.descriptor.name,
            stepId: step.id,
          },
          decided.token,
          certain.frameId,
        );
        lastResult = { stepId: step.id, ...result };
        if (result.status === "done") {
          performed.add(step.id);
          const tally = await getExecution();
          await patch({ allowed: tally.allowed + 1 });
          stepIndex++;
          if (stepIndex >= link.intent.steps.length) {
            await patch({ status: "done" });
            await note({ verdict: "info", detail: "Finished." });
            return;
          }
          continue;
        }
        // Fell through: let the agent see the failure and decide what next.
      } else if (decided && decided.outcome !== "ALLOW") {
        // A refusal is the engine's answer, not something to re-ask a model
        // about. Record it and move on exactly as the slow path does.
        const tally = await getExecution();
        await patch({
          blocked: tally.blocked + (decided.outcome === "DENY" ? 1 : 0),
          approvals: tally.approvals + (decided.outcome === "APPROVAL" ? 1 : 0),
          lastBlock: {
            reason: decided.reason,
            ...(decided.sourceText ? { boundary: decided.sourceText } : {}),
            ...(decided.suggestion ? { suggestion: decided.suggestion } : {}),
          },
          ...(decided.outcome === "APPROVAL" ? { status: "awaiting_approval" as const } : {}),
        });
        await note({
          verdict: decided.outcome === "DENY" ? "DENY" : "APPROVAL",
          stepId: step.id,
          verb,
          detail: decided.reason,
          ...(decided.sourceText ? { boundary: decided.sourceText } : {}),
        });
        if (decided.outcome === "APPROVAL") return;
        lastResult = { stepId: step.id, status: "blocked" };
        stepIndex++;
        if (stepIndex >= link.intent.steps.length) {
          await patch({ status: "done" });
          return;
        }
        continue;
      }
    }

    let reply: TurnResponse;
    try {
      reply = await readJson<TurnResponse>(
        await fetch(`${state.agent}/v1/run/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            execution_id: executionId,
            observation,
            last_result: lastResult,
            // We know which step this is; the agent only remembers being told.
            step_id: step?.id,
          }),
        }),
        "asking the agent what to do next",
      );
    } catch (err) {
      await patch({
        status: "failed",
        error: err instanceof Error ? err.message : "lost contact with the agent",
      });
      return;
    }

    if (reply.status === "done" || reply.status === "failed") {
      /*
       * "Done" is a claim, and it is checked. An agent that believes it has
       * finished without having performed anything is describing a run that
       * did not happen, and saying so is far better than letting the receiver
       * walk away thinking their settings changed.
       */
      const required = link.intent.steps.filter((st) => !performed.has(st.id));
      if (performed.size === 0 && link.intent.steps.length > 0) {
        // Say what it was looking for. "Nothing was done" alone gives the
        // receiver nothing to act on and nobody anything to debug.
        const first = link.intent.steps[0];
        const hint = first?.hints?.[0] as { role?: string; name?: string } | undefined;
        const detail = hint?.name
          ? `Could not find ${hint.role ?? "a control"} “${hint.name}” on this page.`
          : `Step “${first?.title ?? "?"}” has no recorded control to look for.`;

        await note({ verdict: "failed", detail: `Nothing was changed. ${detail}` });
        await patch({ status: "failed", error: `Nothing was done. ${detail}` });
        return;
      }
      await note({
        verdict: required.length ? "failed" : "info",
        detail: required.length
          ? `Finished with ${required.length} step(s) not performed: ${required
              .map((st) => (skipped.has(st.id) ? `${st.title} (skipped)` : st.title))
              .join(", ")}`
          : reply.narration || "Finished.",
      });
      await patch({ status: "done" });
      return;
    }

    if (reply.status === "blocked" || reply.status === "awaiting_approval") {
      const block = reply.block ?? { reason: "blocked" };
      const tally = await getExecution();
      await patch({
        blocked: tally.blocked + (reply.status === "blocked" ? 1 : 0),
        approvals: tally.approvals + (reply.status === "awaiting_approval" ? 1 : 0),
        lastBlock: block,
        status: reply.status === "blocked" ? "running" : "awaiting_approval",
      });
      await note({
        verdict: reply.status === "blocked" ? "DENY" : "APPROVAL",
        stepId: step?.id,
        detail: block.reason,
        ...(block.boundary ? { boundary: block.boundary } : {}),
      });

      if (reply.status === "awaiting_approval") return; // resumed by the panel

      // A blocked step is finished with. Move on rather than retrying, which
      // is the agent hunting for a route around a decision the creator made.
      lastResult = { stepId: step?.id, status: "blocked", boundary: block.boundary };
      stepIndex++;
      if (stepIndex >= link.intent.steps.length) {
        await patch({ status: "done" });
        return;
      }
      continue;
    }

    if (reply.assertion) {
      /*
       * An assertion about a step that never ran cannot pass. Checking the
       * page would be beside the point: on a page where nothing was done, an
       * "is it already set?" check can easily be true for reasons that have
       * nothing to do with us.
       */
      const stepId = reply.assertion.stepId;
      const ran = performed.has(stepId);
      const passed = ran && (await verify(tabId, observation.frameId ?? 0, reply.assertion));
      if (!ran) {
        await note({
          verdict: "failed",
          stepId,
          detail: `cannot verify “${reply.assertion.describe}”: that step was never performed`,
        });
      }
      if (ran) {
        await note({
          verdict: passed ? "verified" : "failed",
          stepId,
          detail: reply.assertion.describe,
        });
      }
      lastResult = {
        stepId,
        status: passed ? "done" : "failed",
        ...(ran ? {} : { reason: "this step has not been performed yet; do it before verifying" }),
      };
      if (passed) stepIndex++;
      continue;
    }

    if (reply.status === "action" && reply.instruction && reply.token) {
      /*
       * Redeem against the hash WE computed for that handle, not the one
       * relayed back to us. A token bound to one value and redeemed against
       * another is refused as wrong_target - on an action the engine had
       * just permitted.
       */
      const chosen = observation.candidates.find((c) => c.handle === reply.instruction!.handle);

      /*
       * No candidate means the agent named a control that is not on this
       * page. Acting anyway sent a hash the token was not bound to, and the
       * run reported "wrong_target" - which describes neither the real
       * problem nor anything the receiver can act on.
       */
      if (!chosen) {
        await note({
          verdict: "failed",
          stepId: reply.instruction.stepId,
          verb: reply.instruction.verb,
          detail: `“${reply.instruction.targetName ?? "that control"}” is not on this page`,
        });
        lastResult = {
          stepId: reply.instruction.stepId,
          status: "failed",
          reason: "the chosen control is not on this page",
        };
        stepIndex++;
        if (stepIndex >= link.intent.steps.length) {
          await patch({ status: "done" });
          return;
        }
        continue;
      }

      const instruction = {
        ...reply.instruction,
        targetHash: chosen.targetHash,
        ...(step?.submits ? { submit: true } : {}),
      };

      const result = await authorizeAndAct(
        tabId,
        state.api,
        executionId,
        instruction,
        reply.token,
        chosen.frameId,
      );
      lastResult = { stepId: instruction.stepId, ...result };
      const signature = `${instruction.stepId}:${result.reason ?? ""}`;
      if (result.status !== "done" && signature === lastFailure) {
        repeated += 1;
        if (repeated >= 3) {
          await note({
            verdict: "failed",
            stepId: instruction.stepId,
            detail: `giving up after ${repeated + 1} identical failures: ${result.reason ?? "unknown"}`,
          });
          await patch({
            status: "failed",
            error: `"${instruction.stepId}" failed repeatedly: ${result.reason ?? "unknown"}`,
          });
          return;
        }
      } else {
        repeated = 0;
        lastFailure = result.status === "done" ? "" : signature;
      }

      if (result.status === "done") {
        performed.add(instruction.stepId);
        const tally = await getExecution();
        await patch({ allowed: tally.allowed + 1 });
        stepIndex++;
      }
      continue;
    }

    // Nothing actionable came back; treat it as the agent having finished.
    await patch({ status: "done" });
    return;
  }

  await note({ verdict: "info", detail: `Stopped after ${MAX_TURNS} turns.` });
  await patch({ status: "done" });
}

/* -------------------------------- the steps ------------------------------- */

/**
 * The tab the workflow should run in.
 *
 * NOT the focused tab. The receiver clicked Run on the consent page, so that
 * is what is in front of them - and running there drove the wrong document
 * entirely: resolution found nothing resembling the workflow, and the agent
 * concluded it had nothing to do. The recording knows where the work happens,
 * so we go there.
 *
 * An already-open tab on that origin is reused rather than duplicated;
 * someone who has YouTube open does not want a second copy of it.
 */
async function targetTab(startUrl: string | undefined): Promise<chrome.tabs.Tab | undefined> {
  if (!startUrl) {
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return focused;
  }

  const target = new URL(startUrl);
  const open = await chrome.tabs.query({});
  const existing = open.find((t) => {
    try {
      return t.url ? new URL(t.url).origin === target.origin : false;
    } catch {
      return false;
    }
  });

  if (existing?.id !== undefined) {
    // Bring it to the right page and to the front, so the receiver can watch.
    await chrome.tabs.update(existing.id, { url: startUrl, active: true });
    await waitForLoad(existing.id);
    return chrome.tabs.get(existing.id);
  }

  const created = await chrome.tabs.create({ url: startUrl, active: true });
  if (created.id !== undefined) await waitForLoad(created.id);
  return created;
}

/** Where a step was demonstrated, when the recording says so. */
function pageUrlFor(step: LinkResponse["intent"]["steps"][number]): string | undefined {
  const page = step.page;
  if (!page || !/^https?:/.test(page.origin)) return undefined;
  return `${page.origin}${page.path}`;
}

async function tabOrigin(tabId: number): Promise<string | undefined> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  try {
    return tab?.url ? new URL(tab.url).origin : undefined;
  } catch {
    return undefined;
  }
}

/** A content script cannot resolve anything until the document exists. */
async function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.status === "complete") {
      // The content script is injected at document_start but still needs a
      // moment to install its listeners before it will answer.
      await new Promise((r) => setTimeout(r, 400));
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Observe, giving the page a few chances to finish rendering.
 *
 * `tab.status === "complete"` means the document loaded, not that the app
 * drew anything. YouTube and anything else built on components render their
 * controls after that, so the first look at a freshly opened tab finds an
 * empty shell and reports the control missing.
 */
async function observeWithRetry(
  tabId: number,
  step: CompiledStep | undefined,
): Promise<Awaited<ReturnType<typeof observe>>> {
  const hints = step?.hints ?? [];
  let observation = await observe(tabId, hints);

  for (let attempt = 0; attempt < 3 && observation.candidates.length === 0; attempt++) {
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    observation = await observe(tabId, hints);
  }
  return observation;
}

/** Ask every frame to resolve, and keep the best answer plus its frame. */
async function observe(
  tabId: number,
  hints: unknown[],
): Promise<{ page: unknown; candidates: FramedCandidate[]; tree?: unknown[]; frameId?: number }> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  const frameIds = frames.length ? frames.map((f) => f.frameId) : [0];

  const replies = await Promise.all(
    frameIds.map(async (frameId) => {
      try {
        const reply = (await chrome.tabs.sendMessage(
          tabId,
          { type: "resolve:request", requestId: String(frameId), hints, verb: "" } as WorkerMessage,
          { frameId },
        )) as { candidates?: Candidate[]; page?: unknown; tree?: unknown[] } | undefined;
        return {
          frameId,
          page: reply?.page,
          tree: reply?.tree,
          candidates: (reply?.candidates ?? []).map((c) => ({ ...c, frameId })),
        };
      } catch {
        return { frameId, page: undefined, tree: undefined, candidates: [] as FramedCandidate[] };
      }
    }),
  );

  const candidates = replies.flatMap((r) => r.candidates).sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  const owning = replies.find((r) => r.frameId === (best?.frameId ?? 0)) ?? replies[0];

  return {
    page: owning?.page,
    candidates,
    // The tree only travels when no frame was confident; it is the expensive
    // path and belongs off the hot one.
    ...(best ? {} : { tree: replies.flatMap((r) => r.tree ?? []).slice(0, 120) }),
    ...(best ? { frameId: best.frameId } : {}),
  };
}

/**
 * Redeem the token, then act.
 *
 * The redeem is the whole point: the extension holds no signing secret, so it
 * cannot tell a real authorization from a forged one. Asking the server to
 * spend the token is how it finds out, and a refusal means nothing happens.
 */
async function authorizeAndAct(
  tabId: number,
  api: string,
  executionId: string,
  instruction: NonNullable<TurnResponse["instruction"]> & { submit?: boolean },
  token: string,
  frameId: number,
): Promise<{ status: string; reason?: string }> {
  let redeemed = false;
  let reason = "";
  try {
    const res = await fetch(`${api}/v1/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        executionId,
        stepId: instruction.stepId,
        verb: instruction.verb,
        targetHash: instruction.targetHash,
      }),
    });
    redeemed = res.ok;
    if (!res.ok) reason = ((await res.json()) as { reason?: string }).reason ?? "refused";
  } catch (err) {
    reason = err instanceof Error ? err.message : "could not reach the authority";
  }

  if (!redeemed) {
    await note({
      verdict: "DENY",
      stepId: instruction.stepId,
      verb: instruction.verb,
      detail: `authorization refused: ${reason}`,
    });
    return { status: "failed", reason };
  }

  // Show the element, briefly, before touching it. The pause is a safety
  // feature first and the clearest beat of the demo second.
  await send(tabId, frameId, { type: "highlight", descriptor: null, verdict: "ALLOW" });

  const result = (await send(tabId, frameId, {
    type: "act:request",
    requestId: instruction.stepId,
    action: {
      handle: instruction.handle,
      verb: instruction.verb,
      op: opFor(instruction.verb, instruction.value),
      ...(instruction.value !== undefined ? { value: instruction.value } : {}),
      ...(instruction.submit ? { submit: true } : {}),
      targetHash: instruction.targetHash,
    },
  })) as ActResult | undefined;

  /*
   * Let the page react before anything looks at it again.
   *
   * A menu animates open, a panel renders, a route transitions. The next
   * step's control frequently does not EXIST until the previous action has
   * settled - opening the account menu is what makes "Appearance" appear -
   * and observing immediately finds a page that has not changed yet, then
   * reports the control as missing.
   */
  // Short, because observeWithRetry already handles a page that needs longer:
  // it looks again, twice, when nothing matched. Waiting 650ms on every action
  // to cover the slow case taxed every fast one.
  if (result?.ok) await new Promise((r) => setTimeout(r, 300));

  await note({
    verdict: result?.ok ? "ALLOW" : "failed",
    stepId: instruction.stepId,
    verb: instruction.verb,
    ...(instruction.targetName ? { target: instruction.targetName } : {}),
    ...(result?.ok ? {} : { detail: result?.reason ?? "the action did not complete" }),
  });

  return result?.ok ? { status: "done" } : { status: "failed", reason: result?.reason ?? "" };
}

/**
 * Which DOM operation a semantic verb implies.
 *
 * The verbs are deliberately tool-agnostic, so this is the one place that maps
 * intent onto mechanism. Defaulting to click rather than refusing keeps the
 * run going on a verb nobody anticipated, which is the common case on an app
 * we have never seen.
 */
function opFor(verb: string, value: string | undefined): "click" | "fill" | "select" | "toggle" {
  if (/^(set_|enter_|type_|fill_|rename)/.test(verb) && value !== undefined) return "fill";
  if (/^(select_|choose_|pick_)/.test(verb)) return "select";
  if (/^(toggle_|enable_|disable_|turn_)/.test(verb)) return "toggle";
  return "click";
}

async function verify(
  tabId: number,
  frameId: number,
  assertion: NonNullable<TurnResponse["assertion"]>,
): Promise<boolean> {
  const result = (await send(tabId, frameId, {
    type: "assert:request",
    requestId: assertion.stepId,
    assertion: assertion as never,
  })) as { passed?: boolean } | undefined;
  return result?.passed === true;
}

/** Ask the authority directly. Used by the fast path; same endpoint, same rules. */
async function decide(
  api: string,
  body: Record<string, unknown>,
): Promise<
  | { outcome: string; reason: string; token?: string; sourceText?: string; suggestion?: string }
  | undefined
> {
  const { policyId, ...action } = body;
  try {
    return await readJson(
      await fetch(`${api}/v1/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policyId, action }),
      }),
      "asking whether this action is permitted",
    );
  } catch {
    // An authority we cannot reach is not a permissive one; fall back to the
    // agent path, which will surface the failure properly.
    return undefined;
  }
}

async function send(tabId: number, frameId: number, message: WorkerMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return undefined;
  }
}
