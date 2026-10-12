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
import { canonicalize as canon, type Policy } from "@intentlink/schema";

// Re-exported from the schema package, which owns the one implementation.
// The extension hashes the same descriptors with Web Crypto, and two copies of
// this function would be two chances to disagree about key order.
export { canonicalize } from "@intentlink/schema";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The policy's identity. `hash` itself is excluded, so hashing a policy that
 * already carries a hash reproduces the same value rather than a new one.
 */
export function policyHash(policy: Policy): string {
  const { hash: _ignored, ...rest } = policy;
  return sha256(canon(rest));
}

/** Hash of a resolved element descriptor. Tokens are bound to this. */
export function targetHash(descriptor: unknown): string {
  return sha256(canon(descriptor));
}
