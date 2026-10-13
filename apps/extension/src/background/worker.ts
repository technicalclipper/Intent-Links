/**
 * The service worker — execution state, server calls, tab orchestration.
 *
 * MV3 kills this worker without warning, so NOTHING durable lives in a module
 * variable. Every piece of state is read from and written to chrome.storage,
 * and the recorder's sequence counter in particular has to survive a restart
 * or a trace silently loses its ordering.
 */

import type { TraceEvent } from "@intentlink/schema";
import type { Candidate } from "../shared/protocol.js";
import { IDLE, beginRun, getExecution, runLoop, setExecution } from "./executor.js";
import type {
  ContentMessage,
  ExecutionState,
  PanelMessage,
  PanelState,
  RecordingState,
} from "../shared/protocol.js";

/** A candidate plus the frame that owns its handle. */
type FramedCandidate = Candidate & { frameId: number };

const KEY_RECORDING = "intentlink:recording";

const IDLE_RECORDING: RecordingState = { status: "idle", events: [], apps: [] };
/* ------------------------------ state access ------------------------------ */

async function getRecording(): Promise<RecordingState> {
  const stored = await chrome.storage.local.get(KEY_RECORDING);
  return (stored[KEY_RECORDING] as RecordingState | undefined) ?? IDLE_RECORDING;
}

async function setRecording(state: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [KEY_RECORDING]: state });
}

/**
 * Appends an event under a lock.
 *
 * Capture events arrive from every frame and tab at once, and a read-modify-
 * write on chrome.storage is not atomic — two events landing together would
 * otherwise race, and one would be lost along with its sequence number. The
 * promise chain serialises them. It lives in a module variable deliberately:
 * if the worker dies the chain is irrelevant, because the next append reads
 * fresh state from storage anyway.
 */
let appendChain: Promise<void> = Promise.resolve();

function appendEvent(event: Omit<TraceEvent, "seq">): Promise<void> {
  appendChain = appendChain.then(async () => {
    const state = await getRecording();
    if (state.status !== "recording") return;

    const seq = state.events.length;
    const full: TraceEvent = { ...event, seq } as TraceEvent;

    const apps = state.apps.includes(event.page.app)
      ? state.apps
      : [...state.apps, event.page.app];

    await setRecording({ ...state, events: [...state.events, full], apps });
  });
  return appendChain;
}

/* -------------------------------- recording ------------------------------- */

async function startRecording(): Promise<void> {
  await setRecording({
    status: "recording",
    startedAt: Date.now(),
    events: [],
    apps: [],
  });
  await broadcastToTabs({ type: "capture:start" });
}

async function stopRecording(): Promise<void> {
  const state = await getRecording();
  await setRecording({ ...state, status: "idle" });
  await broadcastToTabs({ type: "capture:stop" });
}

async function setRecordingStatus(status: RecordingState["status"]): Promise<void> {
  const state = await getRecording();
  await setRecording({ ...state, status });
  await broadcastToTabs({ type: status === "recording" ? "capture:start" : "capture:stop" });
}

/**
 * Deleting an event renumbers the rest.
 *
 * `seq` is an index, not an identity — assertions and hints reference steps by
 * id after compilation, not raw events — so leaving a hole would break the
 * invariant that seq equals position, which the trace schema and the compiler
 * both rely on.
 */
async function deleteEvent(seq: number): Promise<void> {
  const state = await getRecording();
  const events = state.events
    .filter((e) => e.seq !== seq)
    .map((e, i) => ({ ...e, seq: i }));
  await setRecording({ ...state, events });
}

/* -------------------------------- publishing ------------------------------ */

const API_BASE_KEY = "intentlink:apiBase";
const DEFAULT_API = "http://127.0.0.1:8080";

async function apiBase(): Promise<string> {
  const stored = await chrome.storage.local.get(API_BASE_KEY);
  return (stored[API_BASE_KEY] as string | undefined) ?? DEFAULT_API;
}

/**
 * Hand the recording to the server, which compiles it and returns a link.
 *
 * Compilation happens server-side rather than here because it needs a model
 * key, and an API key shipped inside an extension is a key given away to
 * everyone who installs it.
 */
async function publishRecording(boundaries: string): Promise<unknown> {
  const state = await getRecording();
  if (state.events.length === 0) return { error: "nothing recorded yet" };

  const trace = {
    traceId: crypto.randomUUID(),
    createdBy: "creator",
    createdAt: new Date(state.startedAt ?? Date.now()).toISOString(),
    sessions: 1,
    durationMs: Math.max(0, Date.now() - (state.startedAt ?? Date.now())),
    apps: state.apps,
    events: state.events,
  };

  try {
    const res = await fetch(`${await apiBase()}/v1/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trace, boundaries, createdBy: "creator" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { error: (body["error"] as string) ?? `publish failed (${res.status})` };
    return body;
  } catch (err) {
    return {
      error: err instanceof Error ? `cannot reach the API: ${err.message}` : "publish failed",
    };
  }
}

/* --------------------------------- plumbing ------------------------------- */

async function broadcastToTabs(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        // No frameId: this reaches every frame, which is what recording wants
        // - a control the person clicks may live in an embedded pane.
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // No content script in that tab (chrome://, the web store, a tab that
        // has not loaded yet). Not an error worth surfacing.
      }
    }),
  );
}

/**
 * Ask every frame of a tab to resolve, and merge what they find.
 *
 * With the content script in all frames, resolution is a fan-out: each frame
 * searches its own document and the best candidate may be in an embedded pane
 * rather than the top one. Handles are frame-local, so each candidate is
 * stamped with the frame that produced it - that pair is what addresses an
 * element when the time comes to act.
 */
export async function resolveAcrossFrames(
  tabId: number,
  message: unknown,
): Promise<{ candidates: FramedCandidate[]; frames: number[] }> {
  const frames = (await chrome.webNavigation?.getAllFrames?.({ tabId })) ?? null;
  const frameIds = frames?.map((f) => f.frameId) ?? [0];

  const replies = await Promise.all(
    frameIds.map(async (frameId) => {
      try {
        const reply = (await chrome.tabs.sendMessage(tabId, message, { frameId })) as
          | { candidates?: Array<Record<string, unknown>> }
          | undefined;
        return (reply?.candidates ?? []).map((c) => ({ ...c, frameId }) as FramedCandidate);
      } catch {
        // A frame with no content script (about:blank, a sandboxed ad) is not
        // a failure; it simply has nothing to offer.
        return [];
      }
    }),
  );

  const candidates = replies
    .flat()
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  return { candidates, frames: frameIds };
}

async function panelState(): Promise<PanelState> {
  return { recording: await getRecording(), execution: await getExecution() };
}

chrome.runtime.onMessage.addListener((message: ContentMessage | PanelMessage, _sender, respond) => {
  void (async () => {
    switch (message.type) {
      case "capture:event":
        await appendEvent(message.event);
        return respond({ ok: true });

      case "content:ready": {
        // A page - or an iframe within it - that loads mid-recording has to
        // start listening on its own; the worker's broadcast went out before
        // this frame existed.
        const state = await getRecording();
        return respond({ recording: state.status === "recording" });
      }

      case "panel:startRecording":
        await startRecording();
        return respond(await panelState());

      case "panel:stopRecording":
        await stopRecording();
        return respond(await panelState());

      case "panel:pauseRecording":
        await setRecordingStatus("paused");
        return respond(await panelState());

      case "panel:resumeRecording":
        await setRecordingStatus("recording");
        return respond(await panelState());

      case "panel:deleteEvent":
        await deleteEvent(message.seq);
        return respond(await panelState());

      case "panel:getState":
        return respond(await panelState());

      case "panel:publish":
        return respond(await publishRecording(message.boundaries));

      case "panel:abort":
      case "panel:cancelRun":
        await setExecution({ ...(await getExecution()), status: "aborted" });
        return respond(await panelState());

      case "bridge:run": {
        // Opening the panel here matters: the receiver clicked Run on a web
        // page and everything that follows - parameters, the live timeline, a
        // block - happens in the panel, which they may never have opened.
        const state = await beginRun(message.linkId, message.api);
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.windowId !== undefined) {
          await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
        }
        return respond(state);
      }

      case "panel:submitParams":
        // Deliberately not awaited: the loop runs for as long as the workflow
        // takes, and the panel needs its answer now so it can start showing
        // the timeline.
        void runLoop(message.params);
        return respond(await panelState());

      default:
        return respond({ ok: false, reason: "unhandled" });
    }
  })();
  // Keep the message channel open for the async respond above.
  return true;
});

chrome.action?.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
