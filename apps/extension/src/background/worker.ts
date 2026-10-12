/**
 * The service worker — execution state, server calls, tab orchestration.
 *
 * MV3 kills this worker without warning, so NOTHING durable lives in a module
 * variable. Every piece of state is read from and written to chrome.storage,
 * and the recorder's sequence counter in particular has to survive a restart
 * or a trace silently loses its ordering.
 */

import type { TraceEvent } from "@intentlink/schema";
import type {
  ContentMessage,
  ExecutionState,
  PanelMessage,
  PanelState,
  RecordingState,
} from "../shared/protocol.js";

const KEY_RECORDING = "intentlink:recording";
const KEY_EXECUTION = "intentlink:execution";

const IDLE_RECORDING: RecordingState = { status: "idle", events: [], apps: [] };
const IDLE_EXECUTION: ExecutionState = {
  status: "idle",
  allowed: 0,
  blocked: 0,
  approvals: 0,
};

/* ------------------------------ state access ------------------------------ */

async function getRecording(): Promise<RecordingState> {
  const stored = await chrome.storage.local.get(KEY_RECORDING);
  return (stored[KEY_RECORDING] as RecordingState | undefined) ?? IDLE_RECORDING;
}

async function setRecording(state: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [KEY_RECORDING]: state });
}

async function getExecution(): Promise<ExecutionState> {
  const stored = await chrome.storage.local.get(KEY_EXECUTION);
  return (stored[KEY_EXECUTION] as ExecutionState | undefined) ?? IDLE_EXECUTION;
}

async function setExecution(state: ExecutionState): Promise<void> {
  await chrome.storage.local.set({ [KEY_EXECUTION]: state });
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

/* --------------------------------- plumbing ------------------------------- */

async function broadcastToTabs(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // No content script in that tab (chrome://, the web store, a tab that
        // has not loaded yet). Not an error worth surfacing.
      }
    }),
  );
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
        // A page that loads mid-recording has to start listening on its own.
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

      case "panel:abort":
        await setExecution({ ...IDLE_EXECUTION, status: "aborted" });
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
