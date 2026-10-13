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

interface LinkResponse {
  id: string;
  intent: {
    title: string;
    goal: string;
    params: ExecutionState["pendingParams"];
    steps: Array<{ id: string; title: string; hints: unknown[] }>;
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
    const res = await fetch(`${api}/v1/links/${encodeURIComponent(linkId)}`);
    if (!res.ok) throw new Error(`link not found (${res.status})`);
    link = (await res.json()) as LinkResponse;
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

/* --------------------------------- the loop ------------------------------- */

interface TurnResponse {
  status: "action" | "blocked" | "awaiting_approval" | "done" | "failed";
  narration?: string;
  instruction?: {
    handle: number;
    verb: string;
    object?: string;
    value?: string;
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

  const tab = await activeTab();
  if (!tab?.id) {
    await patch({ status: "failed", error: "no active tab to run in" });
    return;
  }

  // Fetch the workflow again rather than trusting anything cached: the steps
  // and their hints are what we resolve against.
  const link = (await (await fetch(`${state.api}/v1/links/${state.linkId}`)).json()) as LinkResponse;

  let executionId: string;
  try {
    const res = await fetch(`${state.agent}/v1/run/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: (link as unknown as { intent: unknown }).intent,
        policy_id: link.policyId,
        params,
        receiver: null,
      }),
    });
    if (!res.ok) throw new Error(`agent refused to start (${res.status})`);
    executionId = ((await res.json()) as { execution_id: string }).execution_id;
  } catch (err) {
    await patch({
      status: "failed",
      error: err instanceof Error ? err.message : "could not start the run",
    });
    return;
  }

  await patch({ status: "running", executionId, pendingParams: [] });

  let lastResult: Record<string, unknown> | null = null;
  let stepIndex = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const current = await getExecution();
    if (current.status === "aborted") return;

    const step = link.intent.steps[Math.min(stepIndex, link.intent.steps.length - 1)];
    const observation = await observe(tab.id, step?.hints ?? []);

    let reply: TurnResponse;
    try {
      const res = await fetch(`${state.agent}/v1/run/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          execution_id: executionId,
          observation,
          last_result: lastResult,
        }),
      });
      reply = (await res.json()) as TurnResponse;
    } catch (err) {
      await patch({
        status: "failed",
        error: err instanceof Error ? err.message : "lost contact with the agent",
      });
      return;
    }

    if (reply.status === "done" || reply.status === "failed") {
      await note({ verdict: "info", detail: reply.narration || "Finished." });
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
      const passed = await verify(tab.id, observation.frameId ?? 0, reply.assertion);
      await note({
        verdict: passed ? "verified" : "failed",
        stepId: reply.assertion.stepId,
        detail: reply.assertion.describe,
      });
      lastResult = { stepId: reply.assertion.stepId, status: passed ? "done" : "failed" };
      stepIndex++;
      continue;
    }

    if (reply.status === "action" && reply.instruction && reply.token) {
      const result = await authorizeAndAct(
        tab.id,
        state.api,
        executionId,
        reply.instruction,
        reply.token,
        observation.frameId ?? 0,
      );
      lastResult = { stepId: reply.instruction.stepId, ...result };
      if (result.status === "done") {
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

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
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
  instruction: NonNullable<TurnResponse["instruction"]>,
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
      targetHash: instruction.targetHash,
    },
  })) as ActResult | undefined;

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

async function send(tabId: number, frameId: number, message: WorkerMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return undefined;
  }
}
