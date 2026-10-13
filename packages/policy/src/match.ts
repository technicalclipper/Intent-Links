/**
 * Matching primitives for policy rules.
 *
 * Patterns are globs over SEMANTIC verbs and objects — never tool names, URLs
 * or selectors. That is what lets one policy govern an action identically
 * whether it executes through an API call or a click in a browser.
 */

import type { ActionRule, ArgConstraint } from "@intentlink/schema";

export type ArgMap = Record<string, string | number | boolean>;

const globCache = new Map<string, RegExp>();

/** `delete_*` becomes /^delete_.*$/ . `*` is the only metacharacter. */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const parts = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^${parts.join(".*")}$`, "i");
  globCache.set(pattern, re);
  return re;
}

export function globMatch(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  return globToRegExp(pattern).test(value);
}

/**
 * How specific a pattern is. When several rules match, the most specific one
 * is reported — a block screen citing `delete_project` is more useful to the
 * receiver than one citing `*`.
 */
export function specificity(pattern: string | undefined): number {
  if (pattern === undefined) return 0;
  const wildcards = (pattern.match(/\*/g) ?? []).length;
  return pattern.length - wildcards * 100;
}

const reCache = new Map<string, RegExp>();

/** Patterns that could not be compiled, so callers can report them. */
const uncompilable = new Set<string>();

/**
 * Patterns the model wrote that JavaScript cannot compile as-is.
 *
 * Reported rather than only failed-closed. A rule whose pattern matches
 * nothing is a boundary that silently does not exist, and a creator who
 * believes they are protected when they are not is the worst outcome
 * available here - the same reason an uncompilable CLAUSE is surfaced.
 */
export function uncompilablePatterns(): string[] {
  return [...uncompilable];
}

/**
 * Inline flags are a PCRE/Python spelling that JavaScript rejects outright.
 *
 * Models reach for `(?i)` constantly, and it cost a real run: a correctly
 * reasoned rule - allow set_theme where theme matches "(?i).*light.*" - threw
 * on compile, fell back to a never-matching pattern, and the step it was
 * written to permit was denied by default. Translating is strictly better than
 * rejecting something whose intent is unambiguous.
 */
function extractInlineFlags(src: string): { source: string; flags: string } {
  const match = /^\(\?([imsux]+)\)/.exec(src);
  if (!match) return { source: src, flags: "" };
  // u and x have no JavaScript equivalent in this position; the rest map over.
  const flags = [...match[1]!].filter((f) => "ims".includes(f)).join("");
  return { source: src.slice(match[0].length), flags };
}

/**
 * Author-supplied regexes are compiled once and cached. A pattern that fails to
 * compile never silently matches — it becomes a regex that matches nothing, so
 * a malformed DENY rule fails closed rather than open.
 */
function safeRegExp(src: string): RegExp {
  const cached = reCache.get(src);
  if (cached) return cached;

  const { source, flags } = extractInlineFlags(src);
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch {
    uncompilable.add(src);
    re = /(?!x)x/;
  }
  reCache.set(src, re);
  return re;
}

function compare(
  op: ArgConstraint["op"],
  actual: string | number | boolean | undefined,
  expected: ArgConstraint["value"],
): boolean {
  const list = Array.isArray(expected) ? expected : [expected];

  switch (op) {
    case "eq":
      return String(actual) === String(expected);
    case "ne":
      return String(actual) !== String(expected);
    case "in":
      return list.some((v) => String(v) === String(actual));
    case "not_in":
      return !list.some((v) => String(v) === String(actual));
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const a = Number(actual);
      const b = Number(Array.isArray(expected) ? expected[0] : expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === "lt") return a < b;
      if (op === "lte") return a <= b;
      if (op === "gt") return a > b;
      return a >= b;
    }
    case "matches":
      return safeRegExp(String(expected)).test(String(actual ?? ""));
    case "not_matches":
      return !safeRegExp(String(expected)).test(String(actual ?? ""));
  }
}

export function argConstraintHolds(c: ArgConstraint, args: ArgMap): boolean {
  return compare(c.op, args[c.arg], c.value);
}

/** A rule matches when verb, object and every arg constraint all hold. */
export function ruleMatches(
  rule: Pick<ActionRule, "verb" | "object" | "args">,
  verb: string,
  object: string | undefined,
  args: ArgMap,
): boolean {
  if (!globMatch(rule.verb, verb)) return false;
  if (rule.object !== undefined && !globMatch(rule.object, object)) return false;
  for (const c of rule.args ?? []) {
    if (!argConstraintHolds(c, args)) return false;
  }
  return true;
}

/** The matching rule a human should be shown: most specific wins. */
export function mostSpecific<T extends Pick<ActionRule, "verb" | "object">>(
  rules: T[],
): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const r of rules) {
    const score = specificity(r.verb) + specificity(r.object);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}
