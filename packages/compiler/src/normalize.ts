/**
 * Trace normalization: deterministic rewrites applied before the model sees
 * a recording, for patterns whose meaning the raw events get wrong.
 *
 * Kept out of the prompt on purpose. A rule the model is asked to follow is a
 * rule it follows most of the time; these are facts about how pages behave,
 * so they are applied in code, every time, and are testable without a model.
 */

import type { Trace, TraceEvent } from "@intentlink/schema";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Roles a person types into to get a suggestion list. */
const TYPEAHEAD_FIELD = new Set(["combobox", "textbox", "searchbox"]);

/** Roles a suggestion list offers. */
const SUGGESTION = new Set(["option", "menuitem", "listitem", "gridcell", "row"]);

/** How far apart, in events, the typing and the pick may be. */
const PICK_WINDOW = 2;

export function normalizeTrace(trace: Trace): Trace {
  return { ...trace, events: collapseAddressPicks(trace.events) };
}

/**
 * An address picked from a suggestion list is an address, not a click.
 *
 * Recording "email someone" in Gmail produced: type "ada" into To, click the
 * suggestion "Beschi J adaibes234@gmail.com". Replayed literally, the receiver
 * typed "ada" into THEIR To field - where their contacts offer nothing of the
 * kind - found no such suggestion, and every step after it was skipped.
 *
 * Suggestions come from the account that is signed in, so they differ for
 * every receiver. What the creator meant is the address itself. So when a
 * pick from a suggestion list carries an email address and sits next to a
 * field the person was typing in, the pair becomes a single fill of that
 * field with the address, and the pick is dropped. Address fields commit a
 * typed address on blur, which the next step provides.
 *
 * Only addresses are collapsed. A suggestion with no address in it ("assign
 * to Jane Doe") is usually the same list for everyone in a shared app, and
 * typing a name alone is often not accepted, so those stay as type-then-pick.
 *
 * Either order is handled: the recorder used to commit the typing on blur,
 * which put it AFTER the pick in traces captured before that was fixed.
 */
function collapseAddressPicks(events: TraceEvent[]): TraceEvent[] {
  const out = events.map((e) => ({ ...e }));
  const drop = new Set<number>();

  for (let i = 0; i < out.length; i++) {
    const pick = out[i]!;
    if (pick.type !== "click" || !pick.target || !SUGGESTION.has(pick.target.role)) continue;
    const raw = EMAIL.exec(pick.target.name)?.[0];
    if (!raw) continue;

    const field = nearestField(out, i, pick, raw, drop);
    if (field === undefined) continue;

    const fill = out[field]!;
    const address = trimGluedName(raw, fill.redacted ? "" : fill.value ?? "");
    fill.type = "fill";
    fill.value = address;
    // The address comes from the suggestion's visible label, which the
    // recording already holds in plain text; nothing new is revealed.
    fill.redacted = false;
    delete fill.redactionReason;
    drop.add(i);
  }

  return out.filter((_, i) => !drop.has(i));
}

/**
 * Separate an address from the contact name glued onto its front.
 *
 * A suggestion's accessible name is its text run together, and Gmail renders
 * "Beschi J I" and "adaibes234@gmail.com" as adjacent spans with no space, so
 * the label reads "Beschi JIadaibes234@gmail.com" and a plain match takes
 * "JIadaibes234@gmail.com" - a different, nonexistent address.
 *
 * What the person typed is the best evidence of where the address starts:
 * they typed "ada", and it begins two letters in, after the capitals. Failing
 * that, a run of capitals stuck to an otherwise lower-case local part is the
 * tail of a name - addresses are rarely written in capitals.
 */
export function trimGluedName(address: string, typed: string): string {
  const at = address.indexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at);

  const t = typed.trim().toLowerCase();
  if (t.length >= 2 && !/\s/.test(t)) {
    const k = local.toLowerCase().indexOf(t);
    // Only where the capitals end: "bes" also occurs inside "adaibes".
    if (k > 0 && /^[A-Z]+$/.test(local.slice(0, k))) return local.slice(k) + domain;
  }

  const glued = /^([A-Z]+)(?=[a-z0-9])/.exec(local);
  if (glued && !/[A-Z]/.test(local.slice(glued[1]!.length))) {
    return local.slice(glued[1]!.length) + domain;
  }
  return address;
}

/**
 * The field this pick belongs to: a fill whose typed text is part of the
 * suggestion, or failing that a click into a typeahead field (some pickers
 * offer suggestions on focus, before anything is typed).
 */
function nearestField(
  events: TraceEvent[],
  at: number,
  pick: TraceEvent,
  address: string,
  taken: Set<number>,
): number | undefined {
  const label = pick.target!.name.toLowerCase();
  const near = (j: number) =>
    j !== at && j >= 0 && j < events.length && !taken.has(j) && Math.abs(j - at) <= PICK_WINDOW;
  const order = [at - 1, at + 1, at - 2, at + 2].filter(near);

  const isField = (e: TraceEvent) =>
    e.target !== undefined && TYPEAHEAD_FIELD.has(e.target.role) && e.page.app === pick.page.app;

  for (const j of order) {
    const e = events[j]!;
    if (e.type !== "fill" || !isField(e)) continue;
    const typed = (e.value ?? "").trim().toLowerCase();
    // A redacted fill hides what was typed; adjacency is the only evidence
    // left, and an address field next to an address pick is enough.
    if (e.redacted || typed === "" || label.includes(typed) || typed === address.toLowerCase()) {
      return j;
    }
  }
  for (const j of order) {
    const e = events[j]!;
    if (e.type === "click" && isField(e)) return j;
  }
  return undefined;
}
