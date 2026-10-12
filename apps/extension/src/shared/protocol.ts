/**
 * Messages between the three halves of the extension.
 *
 * Content script  — reads and touches the page. Deliberately stupid: it
 *                   describes, it resolves, it performs one authorized action.
 *                   No reasoning, no policy, no network.
 * Service worker  — holds execution state, talks to the server, orchestrates
 *                   tabs. Dies without warning (MV3), so every piece of state
 *                   it owns is persisted, never held in a module variable.
 * Side panel      — the human's view and the human's controls.
 */

import type { ElementDescriptor, PageContext, TraceEvent } from "@intentlink/schema";

/* ----------------------------- content → worker --------------------------- */

export type ContentMessage =
  | { type: "capture:event"; event: Omit<TraceEvent, "seq"> }
  | { type: "capture:page"; page: PageContext }
  | { type: "resolve:result"; requestId: string; result: ResolveResult }
  | { type: "act:result"; requestId: string; result: ActResult }
  | { type: "content:ready"; page: PageContext };

/* ----------------------------- worker → content --------------------------- */

export type WorkerMessage =
  | { type: "capture:start" }
  | { type: "capture:stop" }
  | { type: "resolve:request"; requestId: string; hints: ElementDescriptor[]; verb: string }
  | { type: "act:request"; requestId: string; action: PerformRequest }
  | { type: "highlight"; descriptor: ElementDescriptor | null; verdict?: Verdict }
  | { type: "assert:request"; requestId: string; assertion: AssertRequest };

/* --------------------------------- shapes --------------------------------- */

export type Verdict = "ALLOW" | "APPROVAL" | "DENY";

/** How a candidate was found. Reported so the UI can show the agent's work. */
export type ResolutionTier = "exact" | "fuzzy" | "assisted" | "none";

export interface Candidate {
  descriptor: ElementDescriptor;
  /** 0..1. Below the acting threshold we ask a human rather than guess. */
  confidence: number;
  tier: ResolutionTier;
  /** Stable handle for this element within the current page snapshot. */
  handle: number;
  /**
   * sha256 of the descriptor, computed here and echoed by the agent so the
   * issued token binds to this exact element. The agent must never compute or
   * invent it: a model-supplied hash is a guess, and a guess that happens to
   * be well-formed would bind a token to the wrong control.
   */
  targetHash: string;
}

/**
 * A candidate before its hash is attached. resolve() is synchronous and Web
 * Crypto is not, so hashing happens at the boundary where candidates are sent
 * rather than inside the scoring loop.
 */
export type ScoredCandidate = Omit<Candidate, "targetHash">;

export interface ResolveResult {
  candidates: Candidate[];
  /** Compact a11y tree, sent upstream only when tiers 1-2 fail. */
  tree?: ElementDescriptor[];
  page: PageContext;
}

/** What the content script is being told to do, plus proof it may do it. */
export interface PerformRequest {
  handle: number;
  verb: string;
  /** click | fill | select | toggle. Derived from the verb by the worker. */
  op: "click" | "fill" | "select" | "toggle";
  /** Only ever a declared parameter or a recorded literal. */
  value?: string;
  /** Echoed back to the server on redeem; binds the token to this element. */
  targetHash: string;
}

export interface ActResult {
  ok: boolean;
  /** Why it failed: element vanished, disabled, detached, op unsupported. */
  reason?: string;
  /** Descriptor re-read AFTER acting, so the worker can assert postconditions. */
  after?: ElementDescriptor;
}

export interface AssertRequest {
  describe: string;
  target?: Partial<ElementDescriptor>;
  expect: {
    exists?: boolean;
    valueEquals?: string;
    checked?: boolean | "mixed";
    textContains?: string;
  };
}

export interface AssertResult {
  passed: boolean;
  /** What was actually observed, so the UI can show expected vs actual. */
  actual?: string;
}

/* ------------------------------ panel ↔ worker ---------------------------- */

export type PanelMessage =
  | { type: "panel:startRecording" }
  | { type: "panel:stopRecording" }
  | { type: "panel:pauseRecording" }
  | { type: "panel:resumeRecording" }
  | { type: "panel:deleteEvent"; seq: number }
  | { type: "panel:getState" }
  | { type: "panel:publish"; boundaries: string }
  | { type: "panel:runIntent"; intentId: string; params: Record<string, string> }
  | { type: "panel:abort" }
  | { type: "panel:approve"; requestId: string }
  | { type: "panel:cancelApproval"; requestId: string };

export interface RecordingState {
  status: "idle" | "recording" | "paused";
  startedAt?: number;
  events: TraceEvent[];
  apps: string[];
}

export interface ExecutionState {
  status: "idle" | "running" | "blocked" | "awaiting_approval" | "done" | "aborted";
  executionId?: string;
  stepId?: string;
  /** Running tally shown live in the panel. */
  allowed: number;
  blocked: number;
  approvals: number;
  lastBlock?: {
    reason: string;
    boundary?: string;
    suggestion?: string;
  };
}

export type PanelState = { recording: RecordingState; execution: ExecutionState };
