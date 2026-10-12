/**
 * The resolution ladder — the executor half of the shared core.
 *
 * This is resolution, NOT replay. The creator's recording gives us descriptors;
 * the receiver's page gives us candidates; this picks the one that satisfies
 * the same intent. Replay would break the first time a label is reworded, a
 * settings page is redesigned, or the UI renders in another language.
 *
 * Tiers 1 and 2 live here and are fully deterministic — no model, no network.
 * They are expected to carry roughly the common case; tier 3 (Gemini) is only
 * consulted when these produce nothing confident, which keeps both latency and
 * cost off the hot path.
 */

import { describe } from "@intentlink/a11y";
import type { ElementDescriptor } from "@intentlink/schema";
import type { ResolutionTier, ScoredCandidate } from "../shared/protocol.js";
import { deepQueryAll } from "./dom.js";

/** Acting threshold. Below this we ask a human rather than guess. */
export const CONFIDENCE_FLOOR = 0.62;

/**
 * Weights reflect how well each signal survives a redesign, and they sum to
 * exactly 1 so that a perfect match scores 1.
 *
 * `nearby` is weighted heavily for its size because it is the designed
 * tie-breaker for the case the other signals cannot touch: identical controls
 * repeated down a table, where role, name, section and landmark are all the
 * same and only the surrounding row differs.
 */
const W = {
  role: 0.28,
  name: 0.40,
  section: 0.12,
  landmark: 0.06,
  nearby: 0.14,
} as const;

/**
 * A name's trustworthiness depends on where it came from. A <label> survives a
 * visual redesign; raw text content often does not, and a placeholder is barely
 * identity at all. Mirrors NAME_SOURCE_WEIGHT in @intentlink/a11y.
 */
const NAME_SOURCE_TRUST: Record<string, number> = {
  "aria-labelledby": 1.0,
  "aria-label": 1.0,
  label: 1.0,
  alt: 0.9,
  text: 0.85,
  value: 0.85,
  title: 0.7,
  placeholder: 0.6,
};

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "Añadir" and "Anadir" compare equal.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dice coefficient over character bigrams, with token overlap as a floor.
 *
 * Token-level comparison alone is too brittle for UI labels: "Allow external
 * invites" and "Allow external invitations" share two of three tokens and score
 * 0.5, which would sit below the acting threshold even though a human reads
 * them as the same control. Bigrams see the shared stem and score ~0.83.
 *
 * Token overlap is kept as a floor for the opposite case — reordered or
 * padded labels ("Channel name" vs "Name of channel") where the character
 * sequence diverges but the words are the same.
 */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  return Math.max(diceBigrams(na, nb), tokenOverlap(na, nb));
}

function diceBigrams(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      counts.set(gram, left - 1);
      shared++;
    }
  }

  return (2 * shared) / (a.length - 1 + b.length - 1);
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(" "));
  const tb = new Set(b.split(" "));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Score a candidate against a recorded hint.
 *
 * Role is near-categorical: a button is not a textbox, and treating a role
 * mismatch as a small penalty would let a confident name drag the wrong kind
 * of element over the line.
 */
/**
 * The accessible name IS the identity of a control; everything else is
 * context. Below this similarity the candidate is a different control, not a
 * weaker match, so it is rejected outright rather than scored down.
 *
 * Without this gate the weighted sum alone let role+section+landmark+nearby
 * carry a candidate to 0.69 on a name similarity of 0.22 — "Cancel" answering
 * a request for "Create channel" — because the non-name signals contribute a
 * 0.60 floor before the name is even consulted.
 */
export const NAME_FLOOR = 0.45;

export function score(hint: ElementDescriptor, candidate: ElementDescriptor): number {
  if (!rolesCompatible(hint.role, candidate.role)) return 0;

  const nameSimilarity = similarity(hint.name, candidate.name);
  // An empty hint name carries no identity (icon-only controls are real), so
  // there is nothing to gate on and context has to do the work instead.
  if (hint.name !== "" && nameSimilarity < NAME_FLOOR) return 0;

  /*
   * Absence of a signal is neutral, not negative: a signal the hint never
   * carried gets full credit rather than half. Half-credit meant a perfect
   * match could only reach ~0.95, so "exact" was unreachable for any hint that
   * omitted a field — which is most of them. Evidence we do not have is not
   * evidence against.
   */
  const nameTrust =
    hint.nameSource === undefined ? 1 : (NAME_SOURCE_TRUST[hint.nameSource] ?? 0.8);
  const nameScore = nameSimilarity * nameTrust;

  const sectionScore =
    hint.section === undefined
      ? 1
      : candidate.section === undefined
        ? 0.5
        : similarity(hint.section, candidate.section);

  const landmarkScore =
    hint.landmark === undefined ? 1 : hint.landmark === candidate.landmark ? 1 : 0;

  const nearbyScore =
    !hint.nearby?.length
      ? 1
      : !candidate.nearby?.length
        ? 0
        : Math.max(
            ...hint.nearby.map((h) =>
              Math.max(...candidate.nearby!.map((c) => similarity(h, c))),
            ),
          );

  const total =
    W.role +
    W.name * nameScore +
    W.section * sectionScore +
    W.landmark * landmarkScore +
    W.nearby * nearbyScore;

  // A disabled control cannot satisfy an action, whatever else matches.
  return Math.min(1, candidate.disabled ? total * 0.25 : total);
}

/** Roles that can stand in for one another across UI implementations. */
const ROLE_ALIASES: Array<Set<string>> = [
  new Set(["switch", "checkbox"]),
  new Set(["combobox", "listbox", "select"]),
  new Set(["button", "link", "menuitem", "tab"]),
  new Set(["textbox", "searchbox"]),
];

export function rolesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  return ROLE_ALIASES.some((set) => set.has(a) && set.has(b));
}

/** Elements a user could plausibly act on. Keeps the candidate set small. */
export function interactiveElements(root: ParentNode = document): Element[] {
  const selector = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role]", "[tabindex]", "[contenteditable='true']",
  ].join(",");
  // deepQueryAll rather than querySelectorAll: most controls in a web-component
  // app (YouTube, and anything Polymer-based) live inside shadow roots that a
  // plain query cannot cross.
  return deepQueryAll(selector, root).filter(isVisible);
}

/**
 * Visibility without geometry: a hidden element is excluded by what the page
 * declares about it, not by where it sits. Keeps the no-coordinates invariant
 * intact and works the same in a background tab.
 */
export function isVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.hasAttribute("hidden")) return false;
  if ((el as HTMLElement).inert) return false;
  let node: Element | null = el;
  let hops = 0;
  while (node && hops++ < 25) {
    if (node.getAttribute?.("aria-hidden") === "true") return false;
    if (node.hasAttribute?.("hidden")) return false;
    node = node.parentElement;
  }
  return true;
}

export interface ResolveOptions {
  /** Cap on candidates returned; the agent only ever needs the best few. */
  limit?: number;
  root?: ParentNode;
}

/**
 * Tier 1 + tier 2 in one pass: exact matches are simply the ones that score
 * 1.0, so there is no separate scan and no chance of the two tiers disagreeing.
 */
export function resolve(
  hints: ElementDescriptor[],
  opts: ResolveOptions = {},
): { candidates: ScoredCandidate[]; tier: ResolutionTier; handles: Map<number, Element> } {
  const limit = opts.limit ?? 5;
  const elements = interactiveElements(opts.root);
  const handles = new Map<number, Element>();

  const scored: ScoredCandidate[] = [];
  elements.forEach((el, index) => {
    // Passing the pool keeps describe() from scanning the whole document to
    // work out an ordinal - which was both slow and wrong across shadow roots.
    const descriptor = describe(el, { includeValue: false, siblings: elements });
    let best = 0;
    for (const hint of hints) best = Math.max(best, score(hint, descriptor));
    if (best <= 0) return;

    handles.set(index, el);
    scored.push({
      descriptor,
      confidence: best,
      tier: best >= 0.995 ? "exact" : "fuzzy",
      handle: index,
    });
  });

  scored.sort((a, b) => b.confidence - a.confidence);
  const candidates = scored.slice(0, limit);

  /*
   * An ambiguous win is not a win. Two candidates within a hair of each other
   * mean the descriptors do not actually distinguish them — "Remove" on every
   * row of a table — and acting on the higher score would be a coin flip
   * dressed up as a decision. Demote so a human or tier 3 decides.
   */
  const top = candidates[0];
  const runnerUp = candidates[1];
  if (top && runnerUp && top.confidence - runnerUp.confidence < 0.05) {
    top.tier = "fuzzy";
    top.confidence = Math.min(top.confidence, CONFIDENCE_FLOOR - 0.01);
  }

  const tier: ResolutionTier = !top
    ? "none"
    : top.confidence < CONFIDENCE_FLOOR
      ? "none"
      : top.tier;

  return { candidates, tier, handles };
}

/**
 * Compact a11y tree for tier 3. Roles and names only — never raw HTML, which
 * would cost tokens we do not need to spend and widen the injection surface
 * for no benefit.
 */
export function compactTree(opts: { limit?: number } = {}): ElementDescriptor[] {
  return interactiveElements()
    .slice(0, opts.limit ?? 150)
    .map((el) => describe(el, { includeValue: false }));
}
