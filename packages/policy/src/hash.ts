/**
 * Canonicalization and hashing.
 *
 * Two things depend on a byte-stable serialization of a JS value: the policy
 * hash that gets pinned at execution start, and the audit chain. Both are
 * integrity claims, so "whatever JSON.stringify happens to emit" is not good
 * enough — key order must be deterministic regardless of how the object was
 * built or which JSON parser produced it.
 */

import { createHash } from "node:crypto";
import type { Policy } from "@intentlink/schema";

/**
 * Deterministic JSON: object keys sorted, undefined dropped, arrays preserved
 * in order (array order is meaningful — rule precedence depends on it).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The policy's identity. `hash` itself is excluded, so hashing a policy that
 * already carries a hash reproduces the same value rather than a new one.
 */
export function policyHash(policy: Policy): string {
  const { hash: _ignored, ...rest } = policy;
  return sha256(canonicalize(rest));
}

/** Hash of a resolved element descriptor. Tokens are bound to this. */
export function targetHash(descriptor: unknown): string {
  return sha256(canonicalize(descriptor));
}
