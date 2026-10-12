/**
 * Deterministic serialization, shared by everything that hashes.
 *
 * Lives here, in the schema package, precisely because it has NO crypto
 * dependency. The server hashes with node:crypto and the extension hashes with
 * Web Crypto, but both must produce the same bytes for the same descriptor or
 * a token bound at decide time will never match at redeem time.
 *
 * Two implementations of this function would be two chances to disagree about
 * key order, so there is one.
 */

/**
 * Object keys sorted, undefined dropped, array order preserved — array order
 * is meaningful, since rule precedence depends on it.
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

/** True for a value that could be a sha256 hex digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
