/**
 * Descriptor hashing in the browser.
 *
 * Must produce byte-identical results to the server's targetHash(), or a token
 * bound when the action was authorized will never match when it is redeemed.
 * The canonicalization is shared from @intentlink/schema for exactly that
 * reason; only the digest differs, because the browser has Web Crypto and node
 * has node:crypto.
 */

import { canonicalize } from "@intentlink/schema";

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash of a resolved element descriptor. Tokens bind to this. */
export async function targetHash(descriptor: unknown): Promise<string> {
  return sha256Hex(canonicalize(descriptor));
}
