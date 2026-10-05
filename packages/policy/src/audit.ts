/**
 * The audit chain.
 *
 * Every decision, every action, every block and every approval, hash-chained so
 * the log is tamper-evident: altering or dropping an entry breaks every hash
 * after it. This is what lets a creator trust a report about a run that
 * happened inside someone else's browser, and what lets a receiver prove what
 * the agent did and did not do.
 *
 * Entries record the DECISION as well as the outcome, including blocks. A log
 * that only contains successes cannot answer the question the receiver actually
 * has, which is "what did it try?"
 */

import type { Decision, Outcome } from "@intentlink/schema";
import { canonicalize, sha256 } from "./hash.js";

export type AuditKind =
  | "execution_started"
  | "step_started"
  | "action_proposed"
  | "action_executed"
  | "action_blocked"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "resolution_assisted"
  | "resolution_failed"
  | "assertion_checked"
  | "execution_finished"
  | "execution_aborted";

export interface AuditEntryInput {
  kind: AuditKind;
  executionId: string;
  /** ISO 8601. Injected rather than read from a clock, so runs replay. */
  at: string;
  stepId?: string;
  verb?: string;
  object?: string;
  /** Origin + path, or a named resource. Where the action landed. */
  resource?: string;
  outcome?: Outcome;
  ruleId?: string;
  /** The creator's own sentence, preserved so the report reads in English. */
  sourceText?: string;
  approvalId?: string;
  /** Who cleared an approval. Never a credential, only an identity. */
  actor?: string;
  /** Short result summary. Never page content, never values. */
  result?: string;
  assertionPassed?: boolean;
  detail?: string;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  /** Hash of the previous entry; the genesis entry uses 64 zeroes. */
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return sha256(canonicalize(entry));
}

/**
 * Append-only by construction: the only way to add an entry is to hand over
 * the current tail, and the returned entry's hash covers it.
 */
export function appendEntry(
  tail: AuditEntry | undefined,
  input: AuditEntryInput,
): AuditEntry {
  const base: Omit<AuditEntry, "hash"> = {
    ...input,
    seq: tail ? tail.seq + 1 : 0,
    prevHash: tail ? tail.hash : GENESIS_HASH,
  };
  return { ...base, hash: hashEntry(base) };
}

/** Convenience: record a decision, choosing the right kind from its outcome. */
export function entryForDecision(
  tail: AuditEntry | undefined,
  at: string,
  executionId: string,
  stepId: string,
  action: { verb: string; object?: string; resource?: string },
  decision: Decision,
): AuditEntry {
  const kind: AuditKind =
    decision.outcome === "ALLOW"
      ? "action_proposed"
      : decision.outcome === "APPROVAL"
        ? "approval_requested"
        : "action_blocked";

  const input: AuditEntryInput = {
    kind,
    executionId,
    at,
    stepId,
    verb: action.verb,
    outcome: decision.outcome,
    detail: decision.reason,
  };
  if (action.object !== undefined) input.object = action.object;
  if (action.resource !== undefined) input.resource = action.resource;
  if (decision.ruleId !== undefined) input.ruleId = decision.ruleId;
  if (decision.sourceText !== undefined) input.sourceText = decision.sourceText;

  return appendEntry(tail, input);
}

export type ChainVerdict =
  | { ok: true; length: number }
  | { ok: false; brokenAt: number; why: "seq" | "prev_hash" | "hash" };

/**
 * Verify a chain end to end. Reported as the first broken index rather than a
 * boolean, because "where" is the question an investigator has.
 */
export function verifyChain(entries: AuditEntry[]): ChainVerdict {
  let prev: AuditEntry | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return { ok: false, brokenAt: i, why: "seq" };

    const expectedPrev = prev ? prev.hash : GENESIS_HASH;
    if (e.prevHash !== expectedPrev) return { ok: false, brokenAt: i, why: "prev_hash" };

    const { hash, ...rest } = e;
    if (hashEntry(rest) !== hash) return { ok: false, brokenAt: i, why: "hash" };

    prev = e;
  }
  return { ok: true, length: entries.length };
}

export interface ExecutionSummary {
  allowed: number;
  blocked: number;
  approvals: number;
  assertionsPassed: number;
  assertionsFailed: number;
  /** The creator sentences that actually fired. Drives the audit view. */
  boundariesHit: string[];
}

/** The tally the side panel shows live and the report shows at the end. */
export function summarize(entries: AuditEntry[]): ExecutionSummary {
  const summary: ExecutionSummary = {
    allowed: 0,
    blocked: 0,
    approvals: 0,
    assertionsPassed: 0,
    assertionsFailed: 0,
    boundariesHit: [],
  };
  const seen = new Set<string>();

  for (const e of entries) {
    if (e.kind === "action_executed") summary.allowed++;
    if (e.kind === "action_blocked") {
      summary.blocked++;
      if (e.sourceText && !seen.has(e.sourceText)) {
        seen.add(e.sourceText);
        summary.boundariesHit.push(e.sourceText);
      }
    }
    if (e.kind === "approval_granted") summary.approvals++;
    if (e.kind === "assertion_checked") {
      if (e.assertionPassed) summary.assertionsPassed++;
      else summary.assertionsFailed++;
    }
  }
  return summary;
}
