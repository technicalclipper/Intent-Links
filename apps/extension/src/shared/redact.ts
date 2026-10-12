/**
 * Redaction, applied BEFORE a captured value is ever persisted or sent.
 *
 * The recorder watches a human do real work in real systems, so it will see
 * real secrets and real personal data. Those must never reach the trace — not
 * the server, not the IntentLink, not a teammate who opens the recording.
 *
 * This is deliberately eager. A false positive costs the creator one click to
 * un-redact in review; a false negative puts someone's API key in a shared
 * artifact. The asymmetry is not close.
 */

import type { RedactionReason } from "@intentlink/schema";

type Rule = {
  reason: RedactionReason;
  test: RegExp;
  /** Extra condition, for shapes a regex alone over- or under-matches. */
  confirm?: (value: string) => boolean;
};

/**
 * A phone number needs enough digits to be one.
 *
 * The structural pattern alone matched "inc-2026-10-05-payments" — digits and
 * separators in a plausible arrangement — and redacted an ordinary workflow
 * value. Dates, version strings and ticket ids all have that shape; what they
 * do not have is ten digits.
 */
function hasEnoughDigitsForPhone(value: string): boolean {
  return (value.match(/\d/g) ?? []).length >= 10;
}

/**
 * Ordered most-specific first, so the reported reason is the useful one — a
 * creator seeing "credential" learns more than one seeing "secret".
 */
const RULES: Rule[] = [
  { reason: "card", test: /\b(?:\d[ -]*?){13,19}\b/ },
  { reason: "government_id", test: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    reason: "credential",
    test: /\b(?:sk|pk|rk)_(?:live|test|prod)_[A-Za-z0-9]{8,}\b/,
  },
  { reason: "credential", test: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { reason: "credential", test: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { reason: "credential", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // JWT-shaped: three base64url segments.
  { reason: "token", test: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { reason: "email", test: /\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/ },
  { reason: "phone", test: /\+?\d[\d ()-]{8,}\d/, confirm: hasEnoughDigitsForPhone },
];

/**
 * Long high-entropy strings are probably secrets even when they match no known
 * vendor prefix. Catches the in-house token formats every company invents.
 */
function looksHighEntropy(value: string): boolean {
  if (value.length < 24) return false;
  if (/\s/.test(value)) return false;
  const distinct = new Set(value).size;
  const hasMixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasDigits = /\d/.test(value);
  return distinct >= 14 && hasMixedCase && hasDigits;
}

export interface RedactionVerdict {
  redacted: boolean;
  reason?: RedactionReason;
}

/** Field-level signals that make a value sensitive regardless of its content. */
export function fieldIsSensitive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password") {
    return true;
  }
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (/(cc-|current-password|new-password|one-time-code)/.test(autocomplete)) return true;

  const hint = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /(password|passcode|secret|api[_-]?key|token|credential|ssn|card|cvv|pin\b)/.test(hint);
}

export function classify(value: string, el?: Element): RedactionVerdict {
  if (el && fieldIsSensitive(el)) return { redacted: true, reason: "credential" };
  if (!value) return { redacted: false };

  for (const rule of RULES) {
    if (!rule.test.test(value)) continue;
    if (rule.confirm && !rule.confirm(value)) continue;
    return { redacted: true, reason: rule.reason };
  }
  if (looksHighEntropy(value)) return { redacted: true, reason: "secret" };
  return { redacted: false };
}

/**
 * Apply to a captured value. A redacted value is DROPPED, not masked — a mask
 * still leaks length and shape, and nothing downstream needs either.
 */
export function redactValue(
  value: string | undefined,
  el?: Element,
): { value?: string; redacted: boolean; redactionReason?: RedactionReason } {
  if (value === undefined) return { redacted: false };
  const verdict = classify(value, el);
  if (!verdict.redacted) return { value, redacted: false };
  return verdict.reason
    ? { redacted: true, redactionReason: verdict.reason }
    : { redacted: true };
}
