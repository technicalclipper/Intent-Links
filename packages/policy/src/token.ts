/**
 * Execution tokens — the mechanism that makes "the extension is not trusted"
 * literally true.
 *
 * The agent never acts on its own authority. It proposes a semantic action, the
 * policy engine decides, and only on ALLOW does a token come back. The token is
 *
 *   - signed, so the extension cannot mint one;
 *   - bound to (execution, step, verb, resolved target), so a token issued for
 *     "Save" can never be spent on "Delete";
 *   - single-use, so a captured token cannot be replayed;
 *   - short-lived, so one that escapes is worthless in seconds.
 *
 * An approval grant is the same object with a tighter TTL, issued only after a
 * human cleared it. That is what "Approve Once" actually means.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./hash.js";

export interface TokenClaims {
  /** Unique id; the store consumes this to enforce single use. */
  jti: string;
  executionId: string;
  stepId: string;
  verb: string;
  /** sha256 of the resolved descriptor. Absent for non-DOM actions. */
  targetHash?: string;
  /** Issued-at / expiry, epoch seconds. */
  iat: number;
  exp: number;
  /** Rule that authorized it, for the audit trail. */
  ruleId?: string;
  /** Present when a human cleared this specific action. */
  approvalId?: string;
}

export interface IssueOptions {
  ttlSeconds?: number;
  ruleId?: string;
  approvalId?: string;
  /** Injected for deterministic tests. */
  now?: Date;
}

const DEFAULT_TTL_SECONDS = 30;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function issueToken(
  secret: string,
  binding: Omit<TokenClaims, "jti" | "iat" | "exp">,
  opts: IssueOptions = {},
): { token: string; claims: TokenClaims } {
  const now = opts.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const claims: TokenClaims = {
    ...binding,
    jti: randomUUID(),
    iat,
    exp: iat + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  if (opts.ruleId) claims.ruleId = opts.ruleId;
  if (opts.approvalId) claims.approvalId = opts.approvalId;

  const payload = b64url(Buffer.from(canonicalize(claims), "utf8"));
  return { token: `${payload}.${sign(secret, payload)}`, claims };
}

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "already_spent"
  | "wrong_execution"
  | "wrong_step"
  | "wrong_verb"
  | "wrong_target";

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: VerifyFailure };

/** What the extension is about to do, checked against what was authorized. */
export interface SpendIntent {
  executionId: string;
  stepId: string;
  verb: string;
  targetHash?: string;
}

/**
 * Single-use enforcement. The library stays storage-agnostic: the service backs
 * this with Postgres, tests use the in-memory implementation below.
 *
 * `nowEpochSeconds` is a parameter rather than something the store reads for
 * itself. A store that reclaims expired records on a different clock than the
 * verifier uses can drop the record of a spent token while the verifier still
 * considers it live — which makes that token replayable. One clock, passed in.
 */
export interface TokenStore {
  /** True the first time a jti is seen, false on every replay. */
  consume(
    jti: string,
    expEpochSeconds: number,
    nowEpochSeconds: number,
  ): boolean | Promise<boolean>;
}

export class MemoryTokenStore implements TokenStore {
  private readonly spent = new Map<string, number>();

  consume(jti: string, expEpochSeconds: number, nowEpochSeconds: number): boolean {
    this.sweep(nowEpochSeconds);
    if (this.spent.has(jti)) return false;
    this.spent.set(jti, expEpochSeconds);
    return true;
  }

  /**
   * Records are reclaimed only once the token they describe is itself expired
   * by the same clock, so expiry rejects it from then on and nothing is lost.
   */
  private sweep(nowEpochSeconds: number): void {
    for (const [jti, exp] of this.spent) {
      if (exp < nowEpochSeconds) this.spent.delete(jti);
    }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function verifyAndSpend(
  secret: string,
  token: string,
  intent: SpendIntent,
  store: TokenStore,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!constantTimeEqual(signature, sign(secret, payload))) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Binding is checked before expiry so a mismatched token reports the real
  // problem rather than whichever failure happens to trip first.
  if (claims.executionId !== intent.executionId) return { ok: false, reason: "wrong_execution" };
  if (claims.stepId !== intent.stepId) return { ok: false, reason: "wrong_step" };
  if (claims.verb !== intent.verb) return { ok: false, reason: "wrong_verb" };
  if ((claims.targetHash ?? undefined) !== (intent.targetHash ?? undefined)) {
    return { ok: false, reason: "wrong_target" };
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };

  // Consumed last: a token rejected for any other reason must stay unspent, so
  // a near-miss cannot burn the authorization the agent legitimately holds.
  if (!(await store.consume(claims.jti, claims.exp, nowSec))) {
    return { ok: false, reason: "already_spent" };
  }

  return { ok: true, claims };
}
